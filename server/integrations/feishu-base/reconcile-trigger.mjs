import { randomUUID } from "node:crypto";

import { normalizeFeishuBaseConfig } from "./config.mjs";

export const FEISHU_BASE_TRIGGER_DEFAULT_HOUR = 9;
export const FEISHU_BASE_TRIGGER_DEFAULT_MINUTE = 0;

export class FeishuBaseReconcileTriggerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FeishuBaseReconcileTriggerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new FeishuBaseReconcileTriggerError(code, message, details);
}

function requiredString(value, label, maxLength = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    fail("INVALID_TRIGGER_VALUE", `${label} must be a non-empty string`);
  }
  return value;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) fail("INVALID_TRIGGER_TIME", "clock must return a valid date");
  return date;
}

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function millisecondsUntilNextRun(date, timezone, hour, minute) {
  const current = localParts(date, timezone);
  const desired = new Date(date.getTime());
  const currentMinutes = current.hour * 60 + current.minute;
  const desiredMinutes = hour * 60 + minute;
  let days = desiredMinutes > currentMinutes ? 0 : 1;
  if (desiredMinutes === currentMinutes && current.second === 0) days = 0;
  desired.setTime(date.getTime() + ((days * 24 * 60 + desiredMinutes - currentMinutes) * 60 - current.second) * 1000);
  return Math.max(1000, desired.getTime() - date.getTime());
}

function dailyRunId(date, timezone) {
  return `feishu-base-daily:${localParts(date, timezone).date}`;
}

export function createFeishuBaseReconcileTrigger({
  config,
  reconciler,
  clock = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  enableTimer = false,
  dailyHour = FEISHU_BASE_TRIGGER_DEFAULT_HOUR,
  dailyMinute = FEISHU_BASE_TRIGGER_DEFAULT_MINUTE,
} = {}) {
  const normalizedConfig = normalizeFeishuBaseConfig(config);
  if (!reconciler || typeof reconciler.reconcile !== "function") {
    fail("RECONCILER_REQUIRED", "reconciler.reconcile is required");
  }
  if (!Number.isInteger(dailyHour) || dailyHour < 0 || dailyHour > 23) {
    fail("INVALID_TRIGGER_TIME", "dailyHour must be between 0 and 23");
  }
  if (!Number.isInteger(dailyMinute) || dailyMinute < 0 || dailyMinute > 59) {
    fail("INVALID_TRIGGER_TIME", "dailyMinute must be between 0 and 59");
  }

  let timer = null;
  let stopped = false;
  let lastDailyDate = null;

  const runManual = async ({ runId = randomUUID(), metadata = null } = {}) => {
    requiredString(runId, "runId");
    return reconciler.reconcile({
      runId,
      trigger: "manual",
      metadata,
    });
  };

  const runDaily = async ({ at = clock(), metadata = null } = {}) => {
    const date = asDate(at);
    const parts = localParts(date, normalizedConfig.timezone);
    if (lastDailyDate === parts.date) {
      return {
        runId: dailyRunId(date, normalizedConfig.timezone),
        status: "skipped",
        reason: "already_run_for_local_date",
        localDate: parts.date,
      };
    }
    const runId = dailyRunId(date, normalizedConfig.timezone);
    lastDailyDate = parts.date;
    return reconciler.reconcile({
      runId,
      trigger: "daily",
      metadata: {
        localDate: parts.date,
        timezone: normalizedConfig.timezone,
        ...(metadata ?? {}),
      },
    });
  };

  const scheduleNext = () => {
    if (!enableTimer || stopped) return null;
    const delay = millisecondsUntilNextRun(
      asDate(clock()),
      normalizedConfig.timezone,
      dailyHour,
      dailyMinute,
    );
    timer = setTimeoutFn(async () => {
      timer = null;
      if (stopped) return;
      try {
        await runDaily();
      } finally {
        scheduleNext();
      }
    }, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  };

  const start = () => {
    if (enableTimer && timer === null && !stopped) scheduleNext();
    return Object.freeze({ enabled: enableTimer, timerStarted: timer !== null });
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    return Object.freeze({ enabled: false, timerStarted: false });
  };

  return Object.freeze({
    run: runManual,
    runManual,
    runDaily,
    start,
    stop,
    isTimerEnabled: () => enableTimer,
    get timerStarted() {
      return timer !== null;
    },
  });
}

export const createDailyFeishuBaseTrigger = createFeishuBaseReconcileTrigger;
export const createFeishuBaseDailyTrigger = createFeishuBaseReconcileTrigger;
export const createReconcileTrigger = createFeishuBaseReconcileTrigger;
export const createFeishuBaseReconcileScheduler = createFeishuBaseReconcileTrigger;
