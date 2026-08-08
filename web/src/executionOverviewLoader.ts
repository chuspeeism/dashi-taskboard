import type { TaskExecutionOverview } from "./types";

export interface ExecutionOverviewLoadInput {
  taskId: string;
  revision: number;
  localAiChatAvailable: boolean;
}

interface ExecutionOverviewLoaderOptions {
  request: (taskId: string, signal: AbortSignal) => Promise<TaskExecutionOverview>;
  onLoading: () => void;
  onSuccess: (overview: TaskExecutionOverview) => void;
  onError: (error: unknown) => void;
  onDisabled: () => void;
}

export function createExecutionOverviewLoader(options: ExecutionOverviewLoaderOptions) {
  let requestKey: string | null = null;
  let controller: AbortController | null = null;
  let disposed = false;

  function reconcile(input: ExecutionOverviewLoadInput) {
    if (disposed) return;
    if (!input.localAiChatAvailable) {
      controller?.abort();
      controller = null;
      requestKey = null;
      options.onDisabled();
      return;
    }

    const nextRequestKey = `${input.taskId}:${input.revision}`;
    if (requestKey === nextRequestKey) return;
    requestKey = nextRequestKey;
    controller?.abort();
    const nextController = new AbortController();
    controller = nextController;
    options.onLoading();
    void options.request(input.taskId, nextController.signal).then(
      (overview) => {
        if (disposed || controller !== nextController || nextController.signal.aborted) return;
        options.onSuccess(overview);
      },
      (error) => {
        if (disposed || controller !== nextController || nextController.signal.aborted) return;
        options.onError(error);
      },
    );
  }

  function dispose() {
    disposed = true;
    controller?.abort();
    controller = null;
  }

  return { reconcile, dispose };
}
