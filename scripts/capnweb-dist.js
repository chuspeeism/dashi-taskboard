/*
 * Bundled browser build of capnweb, https://github.com/cloudflare/capnweb
 * Version 0.13.1. Vendored unmodified apart from this notice; the #region
 * markers below name the upstream source files it was built from.
 *
 * The injector reads this file and evaluates it inside the Codex renderer,
 * because the app-host RPC session (needed to reach
 * host.services.localAutomations) can only be created in the page with the
 * MessagePort the host hands out. Keep it self-contained: it must run in a
 * renderer with no module loader.
 *
 * ---
 *
 * MIT License
 *
 * Copyright (c) 2025 Cloudflare, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
//#region src/symbols.ts
let WORKERS_MODULE_SYMBOL = Symbol("workers-module");

//#endregion
//#region src/core.ts
if (!Symbol.dispose) Symbol.dispose = Symbol.for("dispose");
if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol.for("asyncDispose");
if (!Promise.withResolvers) Promise.withResolvers = function() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
};
let workersModule = globalThis[WORKERS_MODULE_SYMBOL];
let RpcTarget$1 = workersModule ? workersModule.RpcTarget : class {};
const AsyncFunction = (async function() {}).constructor;
let BUFFER_PROTOTYPE = typeof Buffer !== "undefined" ? Buffer.prototype : void 0;
function typeForRpc(value) {
	switch (typeof value) {
		case "boolean":
		case "number":
		case "string": return "primitive";
		case "undefined": return "undefined";
		case "object":
		case "function": break;
		case "bigint": return "bigint";
		default: return "unsupported";
	}
	if (value === null) return "primitive";
	let prototype = Object.getPrototypeOf(value);
	switch (prototype) {
		case Object.prototype: return "object";
		case Function.prototype:
		case AsyncFunction.prototype: return "function";
		case Array.prototype: return "array";
		case Date.prototype: return "date";
		case Uint8Array.prototype:
		case BUFFER_PROTOTYPE:
		case ArrayBuffer.prototype:
		case DataView.prototype:
		case Int8Array.prototype:
		case Uint8ClampedArray.prototype:
		case Int16Array.prototype:
		case Uint16Array.prototype:
		case Int32Array.prototype:
		case Uint32Array.prototype:
		case BigInt64Array.prototype:
		case BigUint64Array.prototype:
		case Float32Array.prototype:
		case Float64Array.prototype: return "bytes";
		case WritableStream.prototype: return "writable";
		case ReadableStream.prototype: return "readable";
		case URL.prototype: return "url";
		case Headers.prototype: return "headers";
		case Request.prototype: return "request";
		case Response.prototype: return "response";
		case Blob.prototype: return "blob";
		case RpcStub$1.prototype: return "stub";
		case RpcPromise$1.prototype: return "rpc-promise";
		default:
			if (workersModule) {
				if (prototype == workersModule.RpcStub.prototype || value instanceof workersModule.ServiceStub) return "rpc-target";
				else if (prototype == workersModule.RpcPromise.prototype || prototype == workersModule.RpcProperty.prototype) return "rpc-thenable";
			}
			if (value instanceof RpcTarget$1) return "rpc-target";
			if (value instanceof Error) return "error";
			return "unsupported";
	}
}
function mapNotLoaded() {
	throw new Error("RPC map() implementation was not loaded.");
}
let mapImpl = {
	applyMap: mapNotLoaded,
	sendMap: mapNotLoaded
};
function streamNotLoaded() {
	throw new Error("Stream implementation was not loaded.");
}
let streamImpl = {
	createWritableStreamHook: streamNotLoaded,
	createWritableStreamFromHook: streamNotLoaded,
	createReadableStreamHook: streamNotLoaded
};
var StubHook = class {
	stream(path, args) {
		let hook = this.call(path, args);
		let pulled;
		try {
			pulled = hook.pull();
		} catch (err) {
			hook.dispose();
			throw err;
		}
		let promise;
		if (pulled instanceof Promise) promise = pulled.then((p) => {
			p.dispose();
		});
		else {
			pulled.dispose();
			promise = Promise.resolve();
		}
		return { promise };
	}
};
var ErrorStubHook = class extends StubHook {
	error;
	constructor(error) {
		super();
		this.error = error;
	}
	call(path, args) {
		args.dispose();
		return this;
	}
	map(path, captures, instructions) {
		for (let cap of captures) cap.dispose();
		return this;
	}
	get(path) {
		return this;
	}
	dup() {
		return this;
	}
	pull() {
		return Promise.reject(this.error);
	}
	ignoreUnhandledRejections() {}
	dispose() {}
	onBroken(callback) {
		try {
			callback(this.error);
		} catch (err) {
			Promise.resolve(err);
		}
	}
};
const DISPOSED_HOOK = new ErrorStubHook(/* @__PURE__ */ new Error("Attempted to use RPC stub after it has been disposed."));
let doCall = (hook, path, params) => {
	return hook.call(path, params);
};
function withCallInterceptor(interceptor, callback) {
	let oldValue = doCall;
	doCall = interceptor;
	try {
		return callback();
	} finally {
		doCall = oldValue;
	}
}
let RAW_STUB = Symbol("realStub");
const PROXY_HANDLERS = {
	apply(target, thisArg, argumentsList) {
		let stub = target.raw;
		return new RpcPromise$1(doCall(stub.hook, stub.pathIfPromise || [], RpcPayload.fromAppParams(argumentsList)), []);
	},
	get(target, prop, receiver) {
		let stub = target.raw;
		if (prop === RAW_STUB) return stub;
		else if (prop in RpcPromise$1.prototype) return stub[prop];
		else if (typeof prop === "string") return new RpcPromise$1(stub.hook, stub.pathIfPromise ? [...stub.pathIfPromise, prop] : [prop]);
		else if (prop === Symbol.dispose && (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) return () => {
			stub.hook.dispose();
			stub.hook = DISPOSED_HOOK;
		};
		else return;
	},
	has(target, prop) {
		let stub = target.raw;
		if (prop === RAW_STUB) return true;
		else if (prop in RpcPromise$1.prototype) return prop in stub;
		else if (typeof prop === "string") return true;
		else if (prop === Symbol.dispose && (!stub.pathIfPromise || stub.pathIfPromise.length == 0)) return true;
		else return false;
	},
	construct(target, args) {
		throw new Error("An RPC stub cannot be used as a constructor.");
	},
	defineProperty(target, property, attributes) {
		throw new Error("Can't define properties on RPC stubs.");
	},
	deleteProperty(target, p) {
		throw new Error("Can't delete properties on RPC stubs.");
	},
	getOwnPropertyDescriptor(target, p) {},
	getPrototypeOf(target) {
		return Object.getPrototypeOf(target.raw);
	},
	isExtensible(target) {
		return false;
	},
	ownKeys(target) {
		return [];
	},
	preventExtensions(target) {
		return true;
	},
	set(target, p, newValue, receiver) {
		throw new Error("Can't assign properties on RPC stubs.");
	},
	setPrototypeOf(target, v) {
		throw new Error("Can't override prototype of RPC stubs.");
	}
};
var RpcStub$1 = class RpcStub$1 extends RpcTarget$1 {
	constructor(hook, pathIfPromise) {
		super();
		if (!(hook instanceof StubHook)) {
			let value = hook;
			if (value instanceof RpcTarget$1 || value instanceof Function) hook = TargetStubHook.create(value, void 0);
			else hook = new PayloadStubHook(RpcPayload.fromAppReturn(value));
			if (pathIfPromise) throw new TypeError("RpcStub constructor expected one argument, received two.");
		}
		this.hook = hook;
		this.pathIfPromise = pathIfPromise;
		let func = () => {};
		func.raw = this;
		return new Proxy(func, PROXY_HANDLERS);
	}
	hook;
	pathIfPromise;
	dup() {
		let target = this[RAW_STUB];
		if (target.pathIfPromise) return new RpcStub$1(target.hook.get(target.pathIfPromise));
		else return new RpcStub$1(target.hook.dup());
	}
	onRpcBroken(callback) {
		this[RAW_STUB].hook.onBroken(callback);
	}
	map(func) {
		let { hook, pathIfPromise } = this[RAW_STUB];
		return mapImpl.sendMap(hook, pathIfPromise || [], func);
	}
	toString() {
		return "[object RpcStub]";
	}
};
var RpcPromise$1 = class extends RpcStub$1 {
	constructor(hook, pathIfPromise) {
		if (hook instanceof StubHook) super(hook, pathIfPromise ?? []);
		else {
			if (pathIfPromise !== void 0) throw new TypeError("RpcPromise constructor expected one argument, received two.");
			let kind = typeForRpc(hook);
			if (kind === "rpc-promise") {
				let raw = unwrapStubAndPath(hook);
				if (raw.pathIfPromise.length > 0) super(raw.hook, raw.pathIfPromise);
				else {
					let adopted = raw.hook;
					raw.hook = DISPOSED_HOOK;
					super(adopted, []);
				}
			} else if (kind === "rpc-thenable") super(TargetStubHook.create(hook, void 0), []);
			else {
				let promiseHook = new PromiseStubHook(Promise.resolve(hook).then((value) => new PayloadStubHook(RpcPayload.fromAppReturn(value))));
				promiseHook.ignoreUnhandledRejections();
				super(promiseHook, []);
			}
		}
	}
	then(onfulfilled, onrejected) {
		return pullPromise(this).then(...arguments);
	}
	catch(onrejected) {
		return pullPromise(this).catch(...arguments);
	}
	finally(onfinally) {
		return pullPromise(this).finally(...arguments);
	}
	toString() {
		return "[object RpcPromise]";
	}
};
function unwrapStubTakingOwnership(stub) {
	let { hook, pathIfPromise } = stub[RAW_STUB];
	if (pathIfPromise && pathIfPromise.length > 0) return hook.get(pathIfPromise);
	else return hook;
}
function unwrapStubAndDup(stub) {
	let { hook, pathIfPromise } = stub[RAW_STUB];
	if (pathIfPromise) return hook.get(pathIfPromise);
	else return hook.dup();
}
function unwrapStubNoProperties(stub) {
	let { hook, pathIfPromise } = stub[RAW_STUB];
	if (pathIfPromise && pathIfPromise.length > 0) return;
	return hook;
}
function unwrapStubOrParent(stub) {
	return stub[RAW_STUB].hook;
}
function unwrapStubAndPath(stub) {
	return stub[RAW_STUB];
}
async function pullPromise(promise) {
	let { hook, pathIfPromise } = promise[RAW_STUB];
	if (pathIfPromise.length > 0) hook = hook.get(pathIfPromise);
	return (await hook.pull()).deliverResolve();
}
var RpcPayload = class RpcPayload {
	value;
	source;
	hooks;
	promises;
	static fromAppParams(value) {
		return new RpcPayload(value, "params");
	}
	static fromAppReturn(value) {
		return new RpcPayload(value, "return");
	}
	static fromArray(array) {
		let hooks = [];
		let promises = [];
		let resultArray = [];
		for (let payload of array) {
			payload.ensureDeepCopied();
			for (let hook of payload.hooks) hooks.push(hook);
			for (let promise of payload.promises) {
				if (promise.parent === payload) promise = {
					parent: resultArray,
					property: resultArray.length,
					promise: promise.promise
				};
				promises.push(promise);
			}
			resultArray.push(payload.value);
		}
		return new RpcPayload(resultArray, "owned", hooks, promises);
	}
	static forEvaluate(hooks, promises) {
		return new RpcPayload(null, "owned", hooks, promises);
	}
	static deepCopyFrom(value, oldParent, owner) {
		let result = new RpcPayload(null, "owned", [], []);
		result.value = result.deepCopy(value, oldParent, "value", result, true, owner);
		return result;
	}
	constructor(value, source, hooks, promises) {
		this.value = value;
		this.source = source;
		this.hooks = hooks;
		this.promises = promises;
	}
	rpcTargets;
	getHookForRpcTarget(target, parent, dupStubs = true) {
		if (this.source === "params") {
			if (dupStubs) {
				let dupable = target;
				if (typeof dupable.dup === "function") target = dupable.dup();
			}
			return TargetStubHook.create(target, parent);
		} else if (this.source === "return") {
			let hook = this.rpcTargets?.get(target);
			if (hook) if (dupStubs) return hook.dup();
			else {
				this.rpcTargets?.delete(target);
				return hook;
			}
			else {
				hook = TargetStubHook.create(target, parent);
				if (dupStubs) {
					if (!this.rpcTargets) this.rpcTargets = /* @__PURE__ */ new Map();
					this.rpcTargets.set(target, hook);
					return hook.dup();
				} else return hook;
			}
		} else throw new Error("owned payload shouldn't contain raw RpcTargets");
	}
	getHookForWritableStream(stream, parent, dupStubs = true) {
		if (this.source === "params") return streamImpl.createWritableStreamHook(stream);
		else if (this.source === "return") {
			let hook = this.rpcTargets?.get(stream);
			if (hook) if (dupStubs) return hook.dup();
			else {
				this.rpcTargets?.delete(stream);
				return hook;
			}
			else {
				hook = streamImpl.createWritableStreamHook(stream);
				if (dupStubs) {
					if (!this.rpcTargets) this.rpcTargets = /* @__PURE__ */ new Map();
					this.rpcTargets.set(stream, hook);
					return hook.dup();
				} else return hook;
			}
		} else throw new Error("owned payload shouldn't contain raw WritableStreams");
	}
	getHookForReadableStream(stream, parent, dupStubs = true) {
		if (this.source === "params") return streamImpl.createReadableStreamHook(stream);
		else if (this.source === "return") {
			let hook = this.rpcTargets?.get(stream);
			if (hook) if (dupStubs) return hook.dup();
			else {
				this.rpcTargets?.delete(stream);
				return hook;
			}
			else {
				hook = streamImpl.createReadableStreamHook(stream);
				if (dupStubs) {
					if (!this.rpcTargets) this.rpcTargets = /* @__PURE__ */ new Map();
					this.rpcTargets.set(stream, hook);
					return hook.dup();
				} else return hook;
			}
		} else throw new Error("owned payload shouldn't contain raw ReadableStreams");
	}
	deepCopy(value, oldParent, property, parent, dupStubs, owner) {
		switch (typeForRpc(value)) {
			case "unsupported": return value;
			case "primitive":
			case "bigint":
			case "date":
			case "bytes":
			case "blob":
			case "url":
			case "error":
			case "undefined": return value;
			case "array": {
				let array = value;
				let len = array.length;
				let result = new Array(len);
				for (let i = 0; i < len; i++) result[i] = this.deepCopy(array[i], array, i, result, dupStubs, owner);
				return result;
			}
			case "object": {
				let result = {};
				let object = value;
				for (let i in object) result[i] = this.deepCopy(object[i], object, i, result, dupStubs, owner);
				return result;
			}
			case "stub":
			case "rpc-promise": {
				let stub = value;
				let hook;
				if (dupStubs) hook = unwrapStubAndDup(stub);
				else hook = unwrapStubTakingOwnership(stub);
				if (stub instanceof RpcPromise$1) {
					let promise = new RpcPromise$1(hook, []);
					this.promises.push({
						parent,
						property,
						promise
					});
					return promise;
				} else {
					this.hooks.push(hook);
					return new RpcStub$1(hook);
				}
			}
			case "function":
			case "rpc-target": {
				let target = value;
				let hook;
				if (owner) hook = owner.getHookForRpcTarget(target, oldParent, dupStubs);
				else hook = TargetStubHook.create(target, oldParent);
				this.hooks.push(hook);
				return new RpcStub$1(hook);
			}
			case "rpc-thenable": {
				let target = value;
				let promise;
				if (owner) promise = new RpcPromise$1(owner.getHookForRpcTarget(target, oldParent, dupStubs), []);
				else promise = new RpcPromise$1(TargetStubHook.create(target, oldParent), []);
				this.promises.push({
					parent,
					property,
					promise
				});
				return promise;
			}
			case "writable": {
				let stream = value;
				let hook;
				if (owner) hook = owner.getHookForWritableStream(stream, oldParent, dupStubs);
				else hook = streamImpl.createWritableStreamHook(stream);
				this.hooks.push(hook);
				return stream;
			}
			case "readable": {
				let stream = value;
				let hook;
				if (owner) hook = owner.getHookForReadableStream(stream, oldParent, dupStubs);
				else hook = streamImpl.createReadableStreamHook(stream);
				this.hooks.push(hook);
				return stream;
			}
			case "headers": return new Headers(value);
			case "request": {
				let req = value;
				if (req.body) this.deepCopy(req.body, req, "body", req, dupStubs, owner);
				return new Request(req);
			}
			case "response": {
				let resp = value;
				if (resp.body) this.deepCopy(resp.body, resp, "body", resp, dupStubs, owner);
				return new Response(resp.body, resp);
			}
			default: throw new Error("unreachable");
		}
	}
	ensureDeepCopied() {
		if (this.source !== "owned") {
			let dupStubs = this.source === "params";
			this.hooks = [];
			this.promises = [];
			try {
				this.value = this.deepCopy(this.value, void 0, "value", this, dupStubs, this);
			} catch (err) {
				this.hooks = void 0;
				this.promises = void 0;
				throw err;
			}
			this.source = "owned";
			if (this.rpcTargets && this.rpcTargets.size > 0) throw new Error("Not all rpcTargets were accounted for in deep-copy?");
			this.rpcTargets = void 0;
		}
	}
	deliverTo(parent, property, promises) {
		this.ensureDeepCopied();
		if (this.value instanceof RpcPromise$1) RpcPayload.deliverRpcPromiseTo(this.value, parent, property, promises);
		else {
			parent[property] = this.value;
			for (let record of this.promises) RpcPayload.deliverRpcPromiseTo(record.promise, record.parent, record.property, promises);
		}
	}
	static deliverRpcPromiseTo(promise, parent, property, promises) {
		let hook = unwrapStubNoProperties(promise);
		if (!hook) throw new Error("property promises should have been resolved earlier");
		let inner = hook.pull();
		if (inner instanceof RpcPayload) inner.deliverTo(parent, property, promises);
		else promises.push(inner.then((payload) => {
			let subPromises = [];
			payload.deliverTo(parent, property, subPromises);
			if (subPromises.length > 0) return Promise.all(subPromises);
		}));
	}
	async deliverCall(func, thisArg) {
		try {
			let promises = [];
			this.deliverTo(this, "value", promises);
			if (promises.length > 0) await Promise.all(promises);
			let result = Function.prototype.apply.call(func, thisArg, this.value);
			if (result instanceof RpcPromise$1) return RpcPayload.fromAppReturn(result);
			else return RpcPayload.fromAppReturn(await result);
		} finally {
			this.dispose();
		}
	}
	async deliverStreamWrite(writer) {
		try {
			let promises = [];
			this.deliverTo(this, "value", promises);
			if (promises.length > 0) await Promise.all(promises);
			let chunk = this.value[0];
			if ((this.hooks.length > 0 || this.promises.length > 0) && chunk instanceof Object) {
				if (!(Symbol.dispose in chunk)) Object.defineProperty(chunk, Symbol.dispose, {
					value: () => this.dispose(),
					writable: true,
					enumerable: false,
					configurable: true
				});
				await writer.write(chunk);
				return RpcPayload.fromAppReturn(void 0);
			}
			await writer.write(chunk);
			this.dispose();
			return RpcPayload.fromAppReturn(void 0);
		} catch (err) {
			this.dispose();
			throw err;
		}
	}
	async deliverResolve() {
		try {
			let promises = [];
			this.deliverTo(this, "value", promises);
			if (promises.length > 0) await Promise.all(promises);
			let result = this.value;
			if (result instanceof Object) {
				if (!(Symbol.dispose in result)) Object.defineProperty(result, Symbol.dispose, {
					value: () => this.dispose(),
					writable: true,
					enumerable: false,
					configurable: true
				});
			}
			return result;
		} catch (err) {
			this.dispose();
			throw err;
		}
	}
	dispose() {
		if (this.source === "owned") {
			this.hooks.forEach((hook) => hook.dispose());
			this.promises.forEach((promise) => promise.promise[Symbol.dispose]());
		} else if (this.source === "return") {
			this.disposeImpl(this.value, void 0);
			if (this.rpcTargets && this.rpcTargets.size > 0) throw new Error("Not all rpcTargets were accounted for in disposeImpl()?");
		}
		this.source = "owned";
		this.hooks = [];
		this.promises = [];
	}
	disposeImpl(value, parent) {
		switch (typeForRpc(value)) {
			case "unsupported":
			case "primitive":
			case "bigint":
			case "bytes":
			case "blob":
			case "date":
			case "url":
			case "error":
			case "undefined": return;
			case "array": {
				let array = value;
				let len = array.length;
				for (let i = 0; i < len; i++) this.disposeImpl(array[i], array);
				return;
			}
			case "object": {
				let object = value;
				for (let i in object) this.disposeImpl(object[i], object);
				return;
			}
			case "stub":
			case "rpc-promise": {
				let hook = unwrapStubNoProperties(value);
				if (hook) hook.dispose();
				return;
			}
			case "function":
			case "rpc-target": {
				let target = value;
				let hook = this.rpcTargets?.get(target);
				if (hook) {
					hook.dispose();
					this.rpcTargets.delete(target);
				} else disposeRpcTarget(target);
				return;
			}
			case "rpc-thenable": return;
			case "headers": return;
			case "request": {
				let req = value;
				if (req.body) this.disposeImpl(req.body, req);
				return;
			}
			case "response": {
				let resp = value;
				if (resp.body) this.disposeImpl(resp.body, resp);
				return;
			}
			case "writable": {
				let stream = value;
				let hook = this.rpcTargets?.get(stream);
				if (hook) this.rpcTargets.delete(stream);
				else hook = streamImpl.createWritableStreamHook(stream);
				hook.dispose();
				return;
			}
			case "readable": {
				let stream = value;
				let hook = this.rpcTargets?.get(stream);
				if (hook) this.rpcTargets.delete(stream);
				else hook = streamImpl.createReadableStreamHook(stream);
				hook.dispose();
				return;
			}
			default: return;
		}
	}
	ignoreUnhandledRejections() {
		if (this.hooks) {
			this.hooks.forEach((hook) => {
				hook.ignoreUnhandledRejections();
			});
			this.promises.forEach((promise) => unwrapStubOrParent(promise.promise).ignoreUnhandledRejections());
		} else this.ignoreUnhandledRejectionsImpl(this.value);
	}
	ignoreUnhandledRejectionsImpl(value) {
		switch (typeForRpc(value)) {
			case "unsupported":
			case "primitive":
			case "bigint":
			case "bytes":
			case "blob":
			case "date":
			case "error":
			case "undefined":
			case "function":
			case "rpc-target":
			case "writable":
			case "readable":
			case "url":
			case "headers":
			case "request":
			case "response": return;
			case "array": {
				let array = value;
				let len = array.length;
				for (let i = 0; i < len; i++) this.ignoreUnhandledRejectionsImpl(array[i]);
				return;
			}
			case "object": {
				let object = value;
				for (let i in object) this.ignoreUnhandledRejectionsImpl(object[i]);
				return;
			}
			case "stub":
			case "rpc-promise":
				unwrapStubOrParent(value).ignoreUnhandledRejections();
				return;
			case "rpc-thenable":
				value.then((_) => {}, (_) => {});
				return;
			default: return;
		}
	}
};
function followPath(value, parent, path, owner) {
	for (let i = 0; i < path.length; i++) {
		parent = value;
		let part = path[i];
		if (part in Object.prototype) {
			value = void 0;
			continue;
		}
		switch (typeForRpc(value)) {
			case "object":
			case "function":
				if (Object.hasOwn(value, part)) value = value[part];
				else value = void 0;
				break;
			case "array":
				if (Number.isInteger(part) && part >= 0) value = value[part];
				else value = void 0;
				break;
			case "rpc-target":
			case "rpc-thenable":
				if (Object.hasOwn(value, part)) throw new TypeError(`Attempted to access property '${part}', which is an instance property of the RpcTarget. To avoid leaking private internals, instance properties cannot be accessed over RPC. If you want to make this property available over RPC, define it as a method or getter on the class, instead of an instance property.`);
				else value = value[part];
				owner = null;
				break;
			case "stub":
			case "rpc-promise": {
				let { hook, pathIfPromise } = unwrapStubAndPath(value);
				return {
					hook,
					remainingPath: pathIfPromise ? pathIfPromise.concat(path.slice(i)) : path.slice(i)
				};
			}
			case "writable":
				value = void 0;
				break;
			case "readable":
				value = void 0;
				break;
			case "primitive":
			case "bigint":
			case "bytes":
			case "blob":
			case "date":
			case "error":
			case "url":
			case "headers":
			case "request":
			case "response":
				value = void 0;
				break;
			case "undefined":
				value = value[part];
				break;
			case "unsupported": if (i === 0) throw new TypeError(`RPC stub points at a non-serializable type.`);
			else {
				let prefix = path.slice(0, i).join(".");
				let remainder = path.slice(0, i).join(".");
				throw new TypeError(`'${prefix}' is not a serializable type, so property ${remainder} cannot be accessed.`);
			}
			default: throw new TypeError("unreachable");
		}
	}
	if (value instanceof RpcPromise$1) {
		let { hook, pathIfPromise } = unwrapStubAndPath(value);
		return {
			hook,
			remainingPath: pathIfPromise || []
		};
	}
	return {
		value,
		parent,
		owner
	};
}
var ValueStubHook = class extends StubHook {
	call(path, args) {
		let followResult;
		try {
			let { value, owner } = this.getValue();
			followResult = followPath(value, void 0, path, owner);
		} catch (err) {
			args.dispose();
			return new ErrorStubHook(err);
		}
		if (followResult.hook) return followResult.hook.call(followResult.remainingPath, args);
		if (typeof followResult.value != "function") {
			args.dispose();
			return new ErrorStubHook(/* @__PURE__ */ new TypeError(`'${path.join(".")}' is not a function.`));
		}
		return new PromiseStubHook(args.deliverCall(followResult.value, followResult.parent).then((payload) => {
			return new PayloadStubHook(payload);
		}));
	}
	map(path, captures, instructions) {
		try {
			let followResult;
			try {
				let { value, owner } = this.getValue();
				followResult = followPath(value, void 0, path, owner);
			} catch (err) {
				for (let cap of captures) cap.dispose();
				throw err;
			}
			if (followResult.hook) return followResult.hook.map(followResult.remainingPath, captures, instructions);
			return mapImpl.applyMap(followResult.value, followResult.parent, followResult.owner, captures, instructions);
		} catch (err) {
			return new ErrorStubHook(err);
		}
	}
	get(path) {
		try {
			let { value, owner } = this.getValue();
			if (path.length === 0 && owner === null) {
				if (value instanceof Object && "then" in value) return this.dup();
				throw new Error("Can't dup an RpcTarget stub as a promise.");
			}
			let followResult = followPath(value, void 0, path, owner);
			if (followResult.hook) return followResult.hook.get(followResult.remainingPath);
			return new PayloadStubHook(RpcPayload.deepCopyFrom(followResult.value, followResult.parent, followResult.owner));
		} catch (err) {
			return new ErrorStubHook(err);
		}
	}
};
var PayloadStubHook = class PayloadStubHook extends ValueStubHook {
	constructor(payload) {
		super();
		this.payload = payload;
	}
	payload;
	getPayload() {
		if (this.payload) return this.payload;
		else throw new Error("Attempted to use an RPC StubHook after it was disposed.");
	}
	getValue() {
		let payload = this.getPayload();
		return {
			value: payload.value,
			owner: payload
		};
	}
	dup() {
		let thisPayload = this.getPayload();
		return new PayloadStubHook(RpcPayload.deepCopyFrom(thisPayload.value, void 0, thisPayload));
	}
	pull() {
		return this.getPayload();
	}
	ignoreUnhandledRejections() {
		if (this.payload) this.payload.ignoreUnhandledRejections();
	}
	dispose() {
		if (this.payload) {
			this.payload.dispose();
			this.payload = void 0;
		}
	}
	onBroken(callback) {
		if (this.payload) {
			if (this.payload.value instanceof RpcStub$1) this.payload.value.onRpcBroken(callback);
		}
	}
};
function disposeRpcTarget(target) {
	if (Symbol.dispose in target) try {
		target[Symbol.dispose]();
	} catch (err) {
		Promise.reject(err);
	}
}
var TargetStubHook = class TargetStubHook extends ValueStubHook {
	static create(value, parent) {
		if (typeof value !== "function") parent = void 0;
		return new TargetStubHook(value, parent);
	}
	constructor(target, parent, dupFrom) {
		super();
		this.target = target;
		this.parent = parent;
		if (dupFrom) {
			if (dupFrom.refcount) {
				this.refcount = dupFrom.refcount;
				++this.refcount.count;
			}
		} else if (Symbol.dispose in target) this.refcount = { count: 1 };
	}
	target;
	parent;
	refcount;
	getTarget() {
		if (this.target) return this.target;
		else throw new Error("Attempted to use an RPC StubHook after it was disposed.");
	}
	getValue() {
		return {
			value: this.getTarget(),
			owner: null
		};
	}
	dup() {
		return new TargetStubHook(this.getTarget(), this.parent, this);
	}
	pull() {
		let target = this.getTarget();
		if ("then" in target) return Promise.resolve(target).then((resolution) => {
			return RpcPayload.fromAppReturn(resolution);
		});
		else return Promise.reject(/* @__PURE__ */ new Error("Tried to resolve a non-promise stub."));
	}
	ignoreUnhandledRejections() {}
	dispose() {
		if (this.target) {
			if (this.refcount) {
				if (--this.refcount.count == 0) disposeRpcTarget(this.target);
			}
			this.target = void 0;
		}
	}
	onBroken(callback) {
		let target = this.target;
		if (target && "then" in target) Promise.resolve(target).then(() => {}, callback);
	}
};
var PromiseStubHook = class PromiseStubHook extends StubHook {
	promise;
	resolution;
	constructor(promise) {
		super();
		this.promise = promise.then((res) => {
			this.resolution = res;
			return res;
		});
	}
	call(path, args) {
		args.ensureDeepCopied();
		return new PromiseStubHook(this.promise.then((hook) => hook.call(path, args), (err) => {
			args.dispose();
			throw err;
		}));
	}
	stream(path, args) {
		args.ensureDeepCopied();
		return { promise: this.promise.then((hook) => hook.stream(path, args).promise, (err) => {
			args.dispose();
			throw err;
		}) };
	}
	map(path, captures, instructions) {
		return new PromiseStubHook(this.promise.then((hook) => hook.map(path, captures, instructions), (err) => {
			for (let cap of captures) cap.dispose();
			throw err;
		}));
	}
	get(path) {
		return new PromiseStubHook(this.promise.then((hook) => hook.get(path)));
	}
	dup() {
		if (this.resolution) return this.resolution.dup();
		else return new PromiseStubHook(this.promise.then((hook) => hook.dup()));
	}
	pull() {
		if (this.resolution) return this.resolution.pull();
		else return this.promise.then((hook) => hook.pull());
	}
	ignoreUnhandledRejections() {
		if (this.resolution) this.resolution.ignoreUnhandledRejections();
		else this.promise.then((res) => {
			res.ignoreUnhandledRejections();
		}, (err) => {});
	}
	dispose() {
		this.promise.then((hook) => hook.dispose(), () => {});
	}
	onBroken(callback) {
		if (this.resolution) this.resolution.onBroken(callback);
		else this.promise.then((hook) => {
			hook.onBroken(callback);
		}, callback);
	}
};

//#endregion
//#region src/serialize.ts
const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_LIMITS = {
	maxBigIntDigits: 16384,
	maxDepth: 256,
	maxMessageSize: 32 * 1024 * 1024
};
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const BYTE_CONTAINER_TYPE_NAMES = [
	"ArrayBuffer",
	"DataView",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"BigInt64Array",
	"BigUint64Array",
	"Float32Array",
	"Float64Array"
];
function isValidByteContainerName(value) {
	return BYTE_CONTAINER_TYPE_NAMES.includes(value);
}
const TYPED_ARRAY_ELEMENT_SIZE = {
	ArrayBuffer: void 0,
	DataView: void 0,
	Int8Array: void 0,
	Uint8Array: void 0,
	Uint8ClampedArray: void 0,
	Int16Array: 2,
	Uint16Array: 2,
	Int32Array: 4,
	Uint32Array: 4,
	BigInt64Array: 8,
	BigUint64Array: 8,
	Float32Array: 4,
	Float64Array: 8
};
const BYTE_CONTAINER_PROTOTYPES = {
	ArrayBuffer: ArrayBuffer.prototype,
	DataView: DataView.prototype,
	Int8Array: Int8Array.prototype,
	Uint8ClampedArray: Uint8ClampedArray.prototype,
	Int16Array: Int16Array.prototype,
	Uint16Array: Uint16Array.prototype,
	Int32Array: Int32Array.prototype,
	Uint32Array: Uint32Array.prototype,
	BigInt64Array: BigInt64Array.prototype,
	BigUint64Array: BigUint64Array.prototype,
	Float32Array: Float32Array.prototype,
	Float64Array: Float64Array.prototype
};
const BYTE_CONTAINER_TYPE_BY_PROTOTYPE = /* @__PURE__ */ new Map();
for (let type of Object.keys(BYTE_CONTAINER_PROTOTYPES)) BYTE_CONTAINER_TYPE_BY_PROTOTYPE.set(BYTE_CONTAINER_PROTOTYPES[type], type);
function swapByteOrder(bytes, elementSize) {
	if (elementSize !== 2 && elementSize !== 4 && elementSize !== 8) throw new RangeError(`Unsupported element size: ${elementSize}`);
	let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let offset = 0; offset < bytes.byteLength; offset += elementSize) switch (elementSize) {
		case 2:
			view.setUint16(offset, view.getUint16(offset, false), true);
			break;
		case 4:
			view.setUint32(offset, view.getUint32(offset, false), true);
			break;
		case 8:
			view.setBigUint64(offset, view.getBigUint64(offset, false), true);
			break;
	}
}
var NullExporter = class {
	exportStub(stub) {
		throw new Error("Cannot serialize RPC stubs without an RPC session.");
	}
	exportPromise(stub) {
		throw new Error("Cannot serialize RPC stubs without an RPC session.");
	}
	getImport(hook) {}
	unexport(ids) {}
	createPipe(readable) {
		throw new Error("Cannot create pipes without an RPC session.");
	}
	onSendError(error) {}
};
const NULL_EXPORTER = new NullExporter();
async function streamToBlob(stream, type) {
	let b = await new Response(stream).blob();
	return b.type === type ? b : b.slice(0, b.size, type);
}
const ERROR_TYPES = {
	__proto__: null,
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
	AggregateError
};
var Devaluator = class Devaluator {
	exporter;
	source;
	encodingLevel;
	constructor(exporter, source, encodingLevel) {
		this.exporter = exporter;
		this.source = source;
		this.encodingLevel = encodingLevel;
	}
	static devaluate(value, parent, exporter = NULL_EXPORTER, source, encodingLevel = "string") {
		let devaluator = new Devaluator(exporter, source, encodingLevel);
		try {
			return devaluator.devaluateImpl(value, parent, 0);
		} catch (err) {
			if (devaluator.exports) try {
				exporter.unexport(devaluator.exports);
			} catch (err) {}
			throw err;
		}
	}
	exports;
	devaluateImpl(value, parent, depth) {
		if (depth >= 256) throw new Error("Serialization exceeded maximum allowed depth. (Does the message contain cycles?)");
		switch (typeForRpc(value)) {
			case "unsupported": {
				let msg;
				try {
					msg = `Cannot serialize value: ${value}`;
				} catch (err) {
					msg = "Cannot serialize value: (couldn't stringify value)";
				}
				throw new TypeError(msg);
			}
			case "primitive": if (typeof value === "number" && !isFinite(value)) {
				if (this.encodingLevel === "structuredClonable") return value;
				if (value === Infinity) return ["inf"];
				else if (value === -Infinity) return ["-inf"];
				else return ["nan"];
			} else return value;
			case "object": {
				let object = value;
				let result = {};
				for (let key in object) result[key] = this.devaluateImpl(object[key], object, depth + 1);
				return result;
			}
			case "array": {
				let array = value;
				let len = array.length;
				let result = new Array(len);
				for (let i = 0; i < len; i++) result[i] = this.devaluateImpl(array[i], array, depth + 1);
				return [result];
			}
			case "bigint":
				if (this.encodingLevel === "structuredClonable") return value;
				return ["bigint", value.toString()];
			case "date": {
				if (this.encodingLevel === "structuredClonable") return value;
				const time = value.getTime();
				return ["date", Number.isNaN(time) ? null : time];
			}
			case "bytes": {
				let alternateTypeName = BYTE_CONTAINER_TYPE_BY_PROTOTYPE.get(Object.getPrototypeOf(value));
				let bytes;
				if (alternateTypeName === "ArrayBuffer") bytes = new Uint8Array(value);
				else if (alternateTypeName === void 0) bytes = value;
				else {
					let view = value;
					bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
					let elementSize = TYPED_ARRAY_ELEMENT_SIZE[alternateTypeName];
					if (!NATIVE_LITTLE_ENDIAN && elementSize) {
						bytes = bytes.slice();
						swapByteOrder(bytes, elementSize);
					}
				}
				if (this.encodingLevel === "structuredClonable" || this.encodingLevel === "jsonCompatibleWithBytes") return alternateTypeName === void 0 ? ["bytes", bytes] : [
					"bytes",
					bytes,
					alternateTypeName
				];
				let b64;
				if (bytes.toBase64) b64 = bytes.toBase64({ omitPadding: true });
				else if (typeof Buffer !== "undefined") b64 = (bytes instanceof Buffer ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).toString("base64");
				else {
					let binary = "";
					for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
					b64 = btoa(binary);
				}
				b64 = b64.replace(/=+$/, "");
				return alternateTypeName === void 0 ? ["bytes", b64] : [
					"bytes",
					b64,
					alternateTypeName
				];
			}
			case "url": return ["url", value.href];
			case "headers": return ["headers", [...value]];
			case "request": {
				let req = value;
				let init = {};
				if (req.method !== "GET") init.method = req.method;
				let headers = [...req.headers];
				if (headers.length > 0) init.headers = headers;
				if (req.body) {
					init.body = this.devaluateImpl(req.body, req, depth + 1);
					init.duplex = req.duplex || "half";
				} else if (req.body === void 0 && ![
					"GET",
					"HEAD",
					"OPTIONS",
					"TRACE",
					"DELETE"
				].includes(req.method)) {
					let bodyPromise = req.arrayBuffer();
					let readable = new ReadableStream({ async start(controller) {
						try {
							controller.enqueue(new Uint8Array(await bodyPromise));
							controller.close();
						} catch (err) {
							controller.error(err);
						}
					} });
					let hook = streamImpl.createReadableStreamHook(readable);
					init.body = ["readable", this.exporter.createPipe(readable, hook)];
					init.duplex = req.duplex || "half";
				}
				if (req.cache && req.cache !== "default") init.cache = req.cache;
				if (req.redirect !== "follow") init.redirect = req.redirect;
				if (req.integrity) init.integrity = req.integrity;
				if (req.mode && req.mode !== "cors") init.mode = req.mode;
				if (req.credentials && req.credentials !== "same-origin") init.credentials = req.credentials;
				if (req.referrer && req.referrer !== "about:client") init.referrer = req.referrer;
				if (req.referrerPolicy) init.referrerPolicy = req.referrerPolicy;
				if (req.keepalive) init.keepalive = req.keepalive;
				let cfReq = req;
				if (cfReq.cf) init.cf = cfReq.cf;
				if (cfReq.encodeResponseBody && cfReq.encodeResponseBody !== "automatic") init.encodeResponseBody = cfReq.encodeResponseBody;
				return [
					"request",
					req.url,
					init
				];
			}
			case "response": {
				let resp = value;
				let body = this.devaluateImpl(resp.body, resp, depth + 1);
				let init = {};
				if (resp.status !== 200) init.status = resp.status;
				if (resp.statusText) init.statusText = resp.statusText;
				let headers = [...resp.headers];
				if (headers.length > 0) init.headers = headers;
				let cfResp = resp;
				if (cfResp.cf) init.cf = cfResp.cf;
				if (cfResp.encodeBody && cfResp.encodeBody !== "automatic") init.encodeBody = cfResp.encodeBody;
				if (cfResp.webSocket) throw new TypeError("Can't serialize a Response containing a webSocket.");
				return [
					"response",
					body,
					init
				];
			}
			case "blob": {
				let blob = value;
				let readable = blob.stream();
				let hook = streamImpl.createReadableStreamHook(readable);
				let importId = this.exporter.createPipe(readable, hook);
				return [
					"blob",
					blob.type,
					["readable", importId]
				];
			}
			case "error": {
				let e = value;
				let rewritten = this.exporter.onSendError(e);
				if (rewritten) e = rewritten;
				let anyE = e;
				let props;
				let captureProp = (key, val) => {
					let exportsBefore = this.exports?.length ?? 0;
					try {
						let encoded = this.devaluateImpl(val, e, depth + 1);
						if (!props) props = {};
						props[key] = encoded;
					} catch (err) {
						if (this.exports && this.exports.length > exportsBefore) {
							let tail = this.exports.splice(exportsBefore);
							try {
								this.exporter.unexport(tail);
							} catch (err2) {}
						}
					}
				};
				for (let key of Object.keys(e)) {
					if (key === "name" || key === "message" || key === "stack") continue;
					captureProp(key, anyE[key]);
				}
				if ("cause" in e) captureProp("cause", anyE.cause);
				if (e instanceof AggregateError) captureProp("errors", e.errors);
				let result = [
					"error",
					e.name,
					e.message
				];
				if (props) {
					result.push(rewritten && rewritten.stack ? rewritten.stack : null);
					result.push(props);
				} else if (rewritten && rewritten.stack) result.push(rewritten.stack);
				return result;
			}
			case "undefined":
				if (this.encodingLevel === "structuredClonable") return;
				return ["undefined"];
			case "stub":
			case "rpc-promise": {
				if (!this.source) throw new Error("Can't serialize RPC stubs in this context.");
				let { hook, pathIfPromise } = unwrapStubAndPath(value);
				let importId = this.exporter.getImport(hook);
				if (importId !== void 0) if (pathIfPromise) if (pathIfPromise.length > 0) return [
					"pipeline",
					importId,
					pathIfPromise
				];
				else return ["pipeline", importId];
				else return ["import", importId];
				if (pathIfPromise) hook = hook.get(pathIfPromise);
				else hook = hook.dup();
				return this.devaluateHook(pathIfPromise ? "promise" : "export", hook);
			}
			case "function":
			case "rpc-target": {
				if (!this.source) throw new Error("Can't serialize RPC stubs in this context.");
				let hook = this.source.getHookForRpcTarget(value, parent);
				return this.devaluateHook("export", hook);
			}
			case "rpc-thenable": {
				if (!this.source) throw new Error("Can't serialize RPC stubs in this context.");
				let hook = this.source.getHookForRpcTarget(value, parent);
				return this.devaluateHook("promise", hook);
			}
			case "writable": {
				if (!this.source) throw new Error("Can't serialize WritableStream in this context.");
				let hook = this.source.getHookForWritableStream(value, parent);
				return this.devaluateHook("writable", hook);
			}
			case "readable": {
				if (!this.source) throw new Error("Can't serialize ReadableStream in this context.");
				let ws = value;
				let hook = this.source.getHookForReadableStream(ws, parent);
				return ["readable", this.exporter.createPipe(ws, hook)];
			}
			default: throw new Error("unreachable");
		}
	}
	devaluateHook(type, hook) {
		if (!this.exports) this.exports = [];
		let exportId = type === "promise" ? this.exporter.exportPromise(hook) : this.exporter.exportStub(hook);
		this.exports.push(exportId);
		return [type, exportId];
	}
};
/**
* Serialize a value, using Cap'n Web's underlying serialization. This won't be able to serialize
* RPC stubs, but it will support basic data types.
*/
function serialize(value) {
	return JSON.stringify(Devaluator.devaluate(value));
}
var NullImporter = class {
	importStub(idx) {
		throw new Error("Cannot deserialize RPC stubs without an RPC session.");
	}
	importPromise(idx) {
		throw new Error("Cannot deserialize RPC stubs without an RPC session.");
	}
	getExport(idx) {}
	getPipeReadable(exportId) {
		throw new Error("Cannot retrieve pipe readable without an RPC session.");
	}
	getLimits() {
		return DEFAULT_LIMITS;
	}
};
const NULL_IMPORTER = new NullImporter();
function fixBrokenRequestBody(request, body) {
	return new RpcPromise$1(new PromiseStubHook(new Response(body).arrayBuffer().then((arrayBuffer) => {
		let bytes = new Uint8Array(arrayBuffer);
		let result = new Request(request, { body: bytes });
		return new PayloadStubHook(RpcPayload.fromAppReturn(result));
	})), []);
}
function streamToBlobPromise(stream, type) {
	return new RpcPromise$1(new PromiseStubHook(streamToBlob(stream, type).then((blob) => {
		return new PayloadStubHook(RpcPayload.fromAppReturn(blob));
	})), []);
}
var Evaluator = class Evaluator {
	importer;
	encodingLevel;
	limits;
	constructor(importer, encodingLevel = "string") {
		this.importer = importer;
		this.encodingLevel = encodingLevel;
		this.limits = importer.getLimits();
	}
	hooks = [];
	promises = [];
	evaluate(value) {
		return this.evaluateWithDepth(value, 0);
	}
	evaluateWithDepth(value, depth) {
		let payload = RpcPayload.forEvaluate(this.hooks, this.promises);
		try {
			payload.value = this.evaluateImpl(value, payload, "value", depth);
			return payload;
		} catch (err) {
			payload.dispose();
			throw err;
		}
	}
	evaluateCopy(value) {
		return this.evaluate(structuredClone(value));
	}
	evaluateImpl(value, parent, property, depth) {
		let maxDepth = this.limits.maxDepth;
		if (depth >= maxDepth) throw new TypeError(`Deserialization exceeded maximum allowed message depth of ${maxDepth}.`);
		if (this.encodingLevel === "structuredClonable") {
			if (value instanceof Date || typeof value === "bigint") return value;
		}
		if (value instanceof Array) {
			if (value.length == 1 && value[0] instanceof Array) {
				let result = value[0];
				for (let i = 0; i < result.length; i++) result[i] = this.evaluateImpl(result[i], result, i, depth + 1);
				return result;
			} else switch (value[0]) {
				case "bigint":
					if (typeof value[1] == "string") {
						let digits = value[1];
						let maxBigIntDigits = this.limits.maxBigIntDigits;
						if (digits.length > maxBigIntDigits) throw new TypeError(`Deserialized bigint exceeds maximum length of ${maxBigIntDigits} digits.`);
						return BigInt(digits);
					}
					break;
				case "date":
					if (value[1] === null) return /* @__PURE__ */ new Date(NaN);
					if (typeof value[1] == "number") return new Date(value[1]);
					break;
				case "bytes": {
					let bytes;
					if (value[1] instanceof Uint8Array) bytes = value[1];
					else if (typeof value[1] == "string") if (typeof Buffer !== "undefined") bytes = Buffer.from(value[1], "base64");
					else if (Uint8Array.fromBase64) bytes = Uint8Array.fromBase64(value[1]);
					else {
						let bs = atob(value[1]);
						let len = bs.length;
						bytes = new Uint8Array(len);
						for (let i = 0; i < len; i++) bytes[i] = bs.charCodeAt(i);
					}
					else break;
					if (value.length === 2) return bytes;
					if (typeof value[2] !== "string") throw new TypeError(`Unknown bytes type marker type: ${typeof value[2]}`);
					if (!isValidByteContainerName(value[2])) {
						let marker = value[2].slice(0, 64);
						throw new TypeError(`Unknown bytes type marker: ${marker}`);
					}
					let marker = value[2];
					let elementSize = TYPED_ARRAY_ELEMENT_SIZE[marker];
					if (elementSize !== void 0 && bytes.byteLength % elementSize !== 0) throw new TypeError(`Invalid byte length ${bytes.byteLength} for ${marker}; expected a multiple of ${elementSize}`);
					let buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
					if (!NATIVE_LITTLE_ENDIAN && elementSize !== void 0) swapByteOrder(new Uint8Array(buffer), elementSize);
					switch (marker) {
						case "ArrayBuffer": return buffer;
						case "DataView": return new DataView(buffer);
						case "Int8Array": return new Int8Array(buffer);
						case "Uint8Array": return new Uint8Array(buffer);
						case "Uint8ClampedArray": return new Uint8ClampedArray(buffer);
						case "Int16Array": return new Int16Array(buffer);
						case "Uint16Array": return new Uint16Array(buffer);
						case "Int32Array": return new Int32Array(buffer);
						case "Uint32Array": return new Uint32Array(buffer);
						case "BigInt64Array": return new BigInt64Array(buffer);
						case "BigUint64Array": return new BigUint64Array(buffer);
						case "Float32Array": return new Float32Array(buffer);
						case "Float64Array": return new Float64Array(buffer);
						default:
					}
				}
				case "error":
					if (value.length >= 3 && typeof value[1] === "string" && typeof value[2] === "string") {
						let cls = ERROR_TYPES[value[1]] || Error;
						let result = cls === AggregateError ? new cls([], value[2]) : new cls(value[2]);
						if (typeof value[3] === "string") result.stack = value[3];
						if (value.length >= 5) {
							let props = value[4];
							if (!props || typeof props !== "object" || Array.isArray(props)) break;
							let anyResult = result;
							let propsObj = props;
							for (let key of Object.keys(propsObj)) {
								if (key === "name" || key === "message" || key === "stack") continue;
								if (key in Object.prototype || key === "toJSON") {
									this.evaluateImpl(propsObj[key], result, key, depth + 1);
									continue;
								}
								anyResult[key] = this.evaluateImpl(propsObj[key], result, key, depth + 1);
							}
						}
						return result;
					}
					break;
				case "undefined":
					if (value.length === 1) return;
					break;
				case "inf": return Infinity;
				case "-inf": return -Infinity;
				case "nan": return NaN;
				case "url":
					if (value.length === 2 && typeof value[1] === "string") return new URL(value[1]);
					break;
				case "headers":
					if (value.length === 2 && value[1] instanceof Array) return new Headers(value[1]);
					break;
				case "request": {
					if (value.length !== 3 || typeof value[1] !== "string") break;
					let url = value[1];
					let init = value[2];
					if (typeof init !== "object" || init === null) break;
					if (init.body) {
						init.body = this.evaluateImpl(init.body, init, "body", depth + 1);
						if (init.body === null || typeof init.body === "string" || init.body instanceof Uint8Array || init.body instanceof ReadableStream) {} else throw new TypeError("Request body must be of type ReadableStream.");
					}
					if (init.signal) {
						init.signal = this.evaluateImpl(init.signal, init, "signal", depth + 1);
						if (!(init.signal instanceof AbortSignal)) throw new TypeError("Request siganl must be of type AbortSignal.");
					}
					if (init.headers && !(init.headers instanceof Array)) throw new TypeError("Request headers must be serialized as an array of pairs.");
					let result = new Request(url, init);
					if (init.body instanceof ReadableStream && result.body === void 0) {
						let promise = fixBrokenRequestBody(result, init.body);
						this.promises.push({
							promise,
							parent,
							property
						});
						return promise;
					} else return result;
				}
				case "response": {
					if (value.length !== 3) break;
					let body = this.evaluateImpl(value[1], parent, property, depth + 1);
					if (body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream) {} else throw new TypeError("Response body must be of type ReadableStream.");
					let init = value[2];
					if (typeof init !== "object" || init === null) break;
					if (init.webSocket) throw new TypeError("Can't deserialize a Response containing a webSocket.");
					if (init.headers && !(init.headers instanceof Array)) throw new TypeError("Request headers must be serialized as an array of pairs.");
					return new Response(body, init);
				}
				case "blob": {
					if (value.length !== 3 || typeof value[1] !== "string") break;
					let contentType = value[1];
					let content = this.evaluateImpl(value[2], parent, property, depth + 1);
					if (!(content instanceof ReadableStream)) throw new TypeError("Blob content must be serialized as a ReadableStream.");
					let promise = streamToBlobPromise(content, contentType);
					this.promises.push({
						promise,
						parent,
						property
					});
					return promise;
				}
				case "import":
				case "pipeline": {
					if (value.length < 2 || value.length > 4) break;
					if (typeof value[1] != "number") break;
					let hook = this.importer.getExport(value[1]);
					if (!hook) throw new Error(`no such entry on exports table: ${value[1]}`);
					let isPromise = value[0] == "pipeline";
					let addStub = (hook) => {
						if (isPromise) {
							let promise = new RpcPromise$1(hook, []);
							this.promises.push({
								promise,
								parent,
								property
							});
							return promise;
						} else {
							this.hooks.push(hook);
							return new RpcPromise$1(hook, []);
						}
					};
					if (value.length == 2) if (isPromise) return addStub(hook.get([]));
					else return addStub(hook.dup());
					let path = value[2];
					if (!(path instanceof Array)) break;
					if (!path.every((part) => {
						return typeof part == "string" || typeof part == "number";
					})) break;
					if (value.length == 3) return addStub(hook.get(path));
					let args = value[3];
					if (!(args instanceof Array)) break;
					args = new Evaluator(this.importer).evaluateWithDepth([args], depth);
					return addStub(hook.call(path, args));
				}
				case "remap": {
					if (value.length !== 5 || typeof value[1] !== "number" || !(value[2] instanceof Array) || !(value[3] instanceof Array) || !(value[4] instanceof Array)) break;
					let hook = this.importer.getExport(value[1]);
					if (!hook) throw new Error(`no such entry on exports table: ${value[1]}`);
					let path = value[2];
					if (!path.every((part) => {
						return typeof part == "string" || typeof part == "number";
					})) break;
					let captures = value[3].map((cap) => {
						if (!(cap instanceof Array) || cap.length !== 2 || cap[0] !== "import" && cap[0] !== "export" || typeof cap[1] !== "number") throw new TypeError(`unknown map capture: ${JSON.stringify(cap)}`);
						if (cap[0] === "export") return this.importer.importStub(cap[1]);
						else {
							let exp = this.importer.getExport(cap[1]);
							if (!exp) throw new Error(`no such entry on exports table: ${cap[1]}`);
							return exp.dup();
						}
					});
					let instructions = value[4];
					let promise = new RpcPromise$1(hook.map(path, captures, instructions), []);
					this.promises.push({
						promise,
						parent,
						property
					});
					return promise;
				}
				case "export":
				case "promise":
					if (typeof value[1] == "number") if (value[0] == "promise") {
						let promise = new RpcPromise$1(this.importer.importPromise(value[1]), []);
						this.promises.push({
							parent,
							property,
							promise
						});
						return promise;
					} else {
						let hook = this.importer.importStub(value[1]);
						this.hooks.push(hook);
						return new RpcStub$1(hook);
					}
					break;
				case "writable":
					if (typeof value[1] == "number") {
						let hook = this.importer.importStub(value[1]);
						let stream = streamImpl.createWritableStreamFromHook(hook);
						this.hooks.push(hook);
						return stream;
					}
					break;
				case "readable":
					if (typeof value[1] == "number") {
						let stream = this.importer.getPipeReadable(value[1]);
						let hook = streamImpl.createReadableStreamHook(stream);
						this.hooks.push(hook);
						return stream;
					}
					break;
			}
			throw new TypeError(`unknown special value: ${JSON.stringify(value)}`);
		} else if (value instanceof Object) {
			let result = value;
			for (let key in result) if (key in Object.prototype || key === "toJSON") {
				this.evaluateImpl(result[key], result, key, depth + 1);
				delete result[key];
			} else result[key] = this.evaluateImpl(result[key], result, key, depth + 1);
			return result;
		} else return value;
	}
};
/**
* Deserialize a value serialized using serialize().
*/
function deserialize(value) {
	let payload = new Evaluator(NULL_IMPORTER).evaluate(JSON.parse(value));
	payload.dispose();
	return payload.value;
}

//#endregion
//#region src/rpc.ts
const ESTIMATED_OBJECT_OVERHEAD = 16;
const ESTIMATED_ENTRY_OVERHEAD = 8;
const ESTIMATED_BINARY_OVERHEAD = 16;
const MAX_ESTIMATE_DEPTH = 64;
function estimateStringSize(value) {
	return 2 + value.length * 3;
}
function estimateEncodedSize(value, seen, depth = 0) {
	if (depth >= MAX_ESTIMATE_DEPTH) return ESTIMATED_ENTRY_OVERHEAD;
	switch (typeof value) {
		case "string": return estimateStringSize(value);
		case "number": return 16;
		case "bigint": return 16;
		case "boolean": return 8;
		case "undefined": return 16;
		case "object": {
			if (value === null) return 8;
			if (ArrayBuffer.isView(value)) return ESTIMATED_BINARY_OVERHEAD + value.byteLength;
			if (value instanceof ArrayBuffer) return ESTIMATED_BINARY_OVERHEAD + value.byteLength;
			if (typeof Blob !== "undefined" && value instanceof Blob) return ESTIMATED_BINARY_OVERHEAD + value.size;
			if (value instanceof Date) return 16;
			seen ??= /* @__PURE__ */ new WeakSet();
			if (seen.has(value)) return ESTIMATED_ENTRY_OVERHEAD;
			seen.add(value);
			if (value instanceof Array) {
				let size = ESTIMATED_OBJECT_OVERHEAD;
				for (let item of value) size += ESTIMATED_ENTRY_OVERHEAD + estimateEncodedSize(item, seen, depth + 1);
				return size;
			}
			if (value instanceof Error) {
				let size = ESTIMATED_OBJECT_OVERHEAD + estimateStringSize(value.name) + estimateStringSize(value.message) + estimateStringSize(value.stack ?? "");
				for (let key of Object.keys(value)) size += ESTIMATED_ENTRY_OVERHEAD + estimateStringSize(key) + estimateEncodedSize(value[key], seen, depth + 1);
				return size;
			}
			let size = ESTIMATED_OBJECT_OVERHEAD;
			for (let key of Object.keys(value)) size += ESTIMATED_ENTRY_OVERHEAD + estimateStringSize(key) + estimateEncodedSize(value[key], seen, depth + 1);
			return size;
		}
		default: return 16;
	}
}
var ImportTableEntry = class {
	session;
	importId;
	constructor(session, importId, pulling) {
		this.session = session;
		this.importId = importId;
		if (pulling) this.activePull = Promise.withResolvers();
	}
	localRefcount = 0;
	remoteRefcount = 1;
	activePull;
	resolution;
	onBrokenRegistrations;
	resolve(resolution) {
		if (this.localRefcount == 0) {
			resolution.dispose();
			return;
		}
		this.resolution = resolution;
		this.sendRelease();
		if (this.onBrokenRegistrations) {
			for (let i of this.onBrokenRegistrations) {
				let callback = this.session.onBrokenCallbacks[i];
				let endIndex = this.session.onBrokenCallbacks.length;
				resolution.onBroken(callback);
				if (this.session.onBrokenCallbacks[endIndex] === callback) delete this.session.onBrokenCallbacks[endIndex];
				else delete this.session.onBrokenCallbacks[i];
			}
			this.onBrokenRegistrations = void 0;
		}
		if (this.activePull) {
			this.activePull.resolve();
			this.activePull = void 0;
		}
	}
	async awaitResolution() {
		if (!this.activePull) {
			this.session.sendPull(this.importId);
			this.activePull = Promise.withResolvers();
		}
		await this.activePull.promise;
		return this.resolution.pull();
	}
	dispose() {
		if (this.resolution) this.resolution.dispose();
		else {
			this.abort(/* @__PURE__ */ new Error("RPC was canceled because the RpcPromise was disposed."));
			this.sendRelease();
		}
	}
	abort(error) {
		if (!this.resolution) {
			this.resolution = new ErrorStubHook(error);
			if (this.activePull) {
				this.activePull.reject(error);
				this.activePull = void 0;
			}
			this.onBrokenRegistrations = void 0;
		}
	}
	onBroken(callback) {
		if (this.resolution) this.resolution.onBroken(callback);
		else {
			let index = this.session.onBrokenCallbacks.length;
			this.session.onBrokenCallbacks.push(callback);
			if (!this.onBrokenRegistrations) this.onBrokenRegistrations = [];
			this.onBrokenRegistrations.push(index);
		}
	}
	sendRelease() {
		if (this.remoteRefcount > 0) {
			this.session.sendRelease(this.importId, this.remoteRefcount);
			this.remoteRefcount = 0;
		}
	}
};
var RpcImportHook = class RpcImportHook extends StubHook {
	isPromise;
	entry;
	constructor(isPromise, entry) {
		super();
		this.isPromise = isPromise;
		++entry.localRefcount;
		this.entry = entry;
	}
	collectPath(path) {
		return this;
	}
	getEntry() {
		if (this.entry) return this.entry;
		else throw new Error("This RpcImportHook was already disposed.");
	}
	getEntryTakingOwnership(disposeOwned) {
		try {
			return this.getEntry();
		} catch (err) {
			disposeOwned();
			throw err;
		}
	}
	call(path, args) {
		let entry = this.getEntryTakingOwnership(() => args.dispose());
		if (entry.resolution) return entry.resolution.call(path, args);
		else return entry.session.sendCall(entry.importId, path, args);
	}
	stream(path, args) {
		let entry = this.getEntryTakingOwnership(() => args.dispose());
		if (entry.resolution) return entry.resolution.stream(path, args);
		else return entry.session.sendStream(entry.importId, path, args);
	}
	map(path, captures, instructions) {
		let entry = this.getEntryTakingOwnership(() => {
			for (let cap of captures) cap.dispose();
		});
		if (entry.resolution) return entry.resolution.map(path, captures, instructions);
		else return entry.session.sendMap(entry.importId, path, captures, instructions);
	}
	get(path) {
		let entry = this.getEntry();
		if (entry.resolution) return entry.resolution.get(path);
		else return entry.session.sendCall(entry.importId, path);
	}
	dup() {
		return new RpcImportHook(false, this.getEntry());
	}
	pull() {
		let entry = this.getEntry();
		if (!this.isPromise) throw new Error("Can't pull this hook because it's not a promise hook.");
		if (entry.resolution) return entry.resolution.pull();
		return entry.awaitResolution();
	}
	ignoreUnhandledRejections() {}
	dispose() {
		let entry = this.entry;
		this.entry = void 0;
		if (entry) {
			if (--entry.localRefcount === 0) entry.dispose();
		}
	}
	onBroken(callback) {
		if (this.entry) this.entry.onBroken(callback);
	}
};
var RpcMainHook = class extends RpcImportHook {
	session;
	constructor(entry) {
		super(false, entry);
		this.session = entry.session;
	}
	dispose() {
		if (this.session) {
			let session = this.session;
			this.session = void 0;
			session.shutdown();
		}
	}
};
var RpcSessionImpl = class {
	transport;
	options;
	exports = [];
	reverseExports = /* @__PURE__ */ new Map();
	imports = [];
	abortReason;
	cancelReadLoop;
	nextExportId = -1;
	onBatchDone;
	pullCount = 0;
	onBrokenCallbacks = [];
	encodingLevel;
	limits;
	constructor(transport, mainHook, options) {
		this.transport = transport;
		this.options = options;
		let level = "string";
		if ("encodingLevel" in transport) {
			let raw = transport.encodingLevel;
			if (raw !== void 0) {
				if (raw !== "string" && raw !== "jsonCompatible" && raw !== "jsonCompatibleWithBytes" && raw !== "structuredClonable") throw new TypeError(`Unknown transport encodingLevel: ${String(raw)}`);
				level = raw;
			}
		}
		this.encodingLevel = level;
		this.limits = {
			...DEFAULT_LIMITS,
			...options.limits
		};
		this.exports.push({
			hook: mainHook,
			refcount: 1
		});
		this.imports.push(new ImportTableEntry(this, 0, false));
		this.readLoop().catch((err) => this.abort(err));
	}
	getMainImport() {
		return new RpcMainHook(this.imports[0]);
	}
	shutdown() {
		this.abort(/* @__PURE__ */ new Error("RPC session was shut down by disposing the main stub"), false);
	}
	exportStub(hook) {
		if (this.abortReason) throw this.abortReason;
		let existingExportId = this.reverseExports.get(hook);
		if (existingExportId !== void 0) {
			++this.exports[existingExportId].refcount;
			return existingExportId;
		} else {
			let exportId = this.nextExportId--;
			this.exports[exportId] = {
				hook,
				refcount: 1
			};
			this.reverseExports.set(hook, exportId);
			return exportId;
		}
	}
	exportPromise(hook) {
		if (this.abortReason) throw this.abortReason;
		let exportId = this.nextExportId--;
		this.exports[exportId] = {
			hook,
			refcount: 1
		};
		this.reverseExports.set(hook, exportId);
		this.ensureResolvingExport(exportId);
		return exportId;
	}
	unexport(ids) {
		for (let id of ids) this.releaseExport(id, 1);
	}
	releaseExport(exportId, refcount) {
		let entry = this.exports[exportId];
		if (!entry) throw new Error(`no such export ID: ${exportId}`);
		if (entry.refcount < refcount) throw new Error(`refcount would go negative: ${entry.refcount} < ${refcount}`);
		entry.refcount -= refcount;
		if (entry.refcount === 0) {
			delete this.exports[exportId];
			this.reverseExports.delete(entry.hook);
			entry.hook.dispose();
		}
	}
	onSendError(error) {
		if (this.options.onSendError) return this.options.onSendError(error);
	}
	ensureResolvingExport(exportId) {
		let exp = this.exports[exportId];
		if (!exp) throw new Error(`no such export ID: ${exportId}`);
		if (!exp.pull) {
			let resolve = async () => {
				let hook = exp.hook;
				for (;;) {
					let payload = await hook.pull();
					if (payload.value instanceof RpcStub$1) {
						let { hook: inner, pathIfPromise } = unwrapStubAndPath(payload.value);
						if (pathIfPromise && pathIfPromise.length == 0) {
							if (this.getImport(hook) === void 0) {
								hook = inner;
								continue;
							}
						}
					}
					return payload;
				}
			};
			let autoRelease = exp.autoRelease;
			++this.pullCount;
			exp.pull = resolve().then((payload) => {
				let value = Devaluator.devaluate(payload.value, void 0, this, payload, this.encodingLevel);
				this.send([
					"resolve",
					exportId,
					value
				]);
				if (autoRelease) this.releaseExport(exportId, 1);
			}, (error) => {
				this.send([
					"reject",
					exportId,
					Devaluator.devaluate(error, void 0, this, void 0, this.encodingLevel)
				]);
				if (autoRelease) this.releaseExport(exportId, 1);
			}).catch((error) => {
				try {
					this.send([
						"reject",
						exportId,
						Devaluator.devaluate(error, void 0, this, void 0, this.encodingLevel)
					]);
					if (autoRelease) this.releaseExport(exportId, 1);
				} catch (error2) {
					this.abort(error2);
				}
			}).finally(() => {
				if (--this.pullCount === 0) {
					if (this.onBatchDone) this.onBatchDone.resolve();
				}
			});
		}
	}
	getImport(hook) {
		if (hook instanceof RpcImportHook && hook.entry && hook.entry.session === this) return hook.entry.importId;
		else return;
	}
	importStub(idx) {
		if (this.abortReason) throw this.abortReason;
		let entry = this.imports[idx];
		if (!entry) {
			entry = new ImportTableEntry(this, idx, false);
			this.imports[idx] = entry;
		}
		return new RpcImportHook(false, entry);
	}
	importPromise(idx) {
		if (this.abortReason) throw this.abortReason;
		if (this.imports[idx]) return new ErrorStubHook(/* @__PURE__ */ new Error("Bug in RPC system: The peer sent a promise reusing an existing export ID."));
		let entry = new ImportTableEntry(this, idx, true);
		this.imports[idx] = entry;
		return new RpcImportHook(true, entry);
	}
	getExport(idx) {
		return this.exports[idx]?.hook;
	}
	getPipeReadable(exportId) {
		let entry = this.exports[exportId];
		if (!entry || !entry.pipeReadable) throw new Error(`Export ${exportId} is not a pipe or its readable end was already consumed.`);
		let readable = entry.pipeReadable;
		entry.pipeReadable = void 0;
		return readable;
	}
	getLimits() {
		return this.limits;
	}
	createPipe(readable, readableHook) {
		if (this.abortReason) throw this.abortReason;
		this.send(["pipe"]);
		let importId = this.imports.length;
		let entry = new ImportTableEntry(this, importId, false);
		this.imports.push(entry);
		let hook = new RpcImportHook(false, entry);
		let writable = streamImpl.createWritableStreamFromHook(hook);
		readable.pipeTo(writable).catch(() => {}).finally(() => readableHook.dispose());
		return importId;
	}
	send(msg) {
		if (this.abortReason !== void 0) return 0;
		if (this.encodingLevel === "string") {
			let msgText;
			try {
				msgText = JSON.stringify(msg);
			} catch (err) {
				try {
					this.abort(err);
				} catch (err2) {}
				throw err;
			}
			try {
				let sent = this.transport.send(msgText);
				if (sent !== void 0 && typeof sent.catch === "function") sent.catch((err) => this.abort(err, false));
			} catch (err) {
				queueMicrotask(() => this.abort(err, false));
			}
			return msgText.length;
		} else try {
			let size = this.transport.send(msg);
			if (typeof size === "number") return size;
			let thenable = size;
			if (thenable && typeof thenable.then === "function") Promise.resolve(thenable).catch((err) => this.abort(err, false));
			return;
		} catch (err) {
			queueMicrotask(() => this.abort(err, false));
			return;
		}
	}
	sendCall(id, path, args) {
		if (this.abortReason) {
			args?.dispose();
			throw this.abortReason;
		}
		let value = [
			"pipeline",
			id,
			path
		];
		if (args) {
			let devalue;
			try {
				devalue = Devaluator.devaluate(args.value, void 0, this, args, this.encodingLevel);
			} catch (err) {
				args.dispose();
				throw err;
			}
			value.push(devalue[0]);
		}
		this.send(["push", value]);
		let entry = new ImportTableEntry(this, this.imports.length, false);
		this.imports.push(entry);
		return new RpcImportHook(true, entry);
	}
	sendStream(id, path, args) {
		if (this.abortReason) {
			args.dispose();
			throw this.abortReason;
		}
		let value = [
			"pipeline",
			id,
			path
		];
		let devalue;
		try {
			devalue = Devaluator.devaluate(args.value, void 0, this, args, this.encodingLevel);
		} catch (err) {
			args.dispose();
			throw err;
		}
		value.push(devalue[0]);
		let msg = ["stream", value];
		let size = this.send(msg);
		if (size === void 0) size = estimateEncodedSize(msg);
		let importId = this.imports.length;
		let entry = new ImportTableEntry(this, importId, true);
		entry.remoteRefcount = 0;
		entry.localRefcount = 1;
		this.imports.push(entry);
		return {
			promise: entry.awaitResolution().then((p) => {
				p.dispose();
				delete this.imports[importId];
			}, (err) => {
				delete this.imports[importId];
				throw err;
			}),
			size
		};
	}
	sendMap(id, path, captures, instructions) {
		if (this.abortReason) {
			for (let cap of captures) cap.dispose();
			throw this.abortReason;
		}
		let value = [
			"remap",
			id,
			path,
			captures.map((hook) => {
				let importId = this.getImport(hook);
				if (importId !== void 0) return ["import", importId];
				else return ["export", this.exportStub(hook)];
			}),
			instructions
		];
		this.send(["push", value]);
		let entry = new ImportTableEntry(this, this.imports.length, false);
		this.imports.push(entry);
		return new RpcImportHook(true, entry);
	}
	sendPull(id) {
		if (this.abortReason) throw this.abortReason;
		this.send(["pull", id]);
	}
	sendRelease(id, remoteRefcount) {
		if (this.abortReason) return;
		this.send([
			"release",
			id,
			remoteRefcount
		]);
		delete this.imports[id];
	}
	abort(error, trySendAbortMessage = true) {
		if (this.abortReason !== void 0) return;
		this.cancelReadLoop?.(error);
		this.cancelReadLoop = void 0;
		if (trySendAbortMessage) try {
			let abortMsg = ["abort", Devaluator.devaluate(error, void 0, this, void 0, this.encodingLevel)];
			if (this.encodingLevel === "string") {
				let sent = this.transport.send(JSON.stringify(abortMsg));
				if (sent !== void 0 && typeof sent.catch === "function") sent.catch((err) => {});
			} else {
				let result = this.transport.send(abortMsg);
				if (result && typeof result.then === "function") Promise.resolve(result).catch((err) => {});
			}
		} catch (err) {}
		if (error === void 0) error = "undefined";
		this.abortReason = error;
		if (this.onBatchDone) this.onBatchDone.reject(error);
		if (this.transport.abort) try {
			this.transport.abort(error);
		} catch (err) {
			Promise.resolve(err);
		}
		for (let i in this.onBrokenCallbacks) try {
			this.onBrokenCallbacks[i](error);
		} catch (err) {
			Promise.resolve(err);
		}
		for (let i in this.imports) this.imports[i].abort(error);
		for (let i in this.exports) this.exports[i].hook.dispose();
	}
	async readLoop() {
		while (!this.abortReason) {
			let readCanceled = Promise.withResolvers();
			this.cancelReadLoop = readCanceled.reject;
			let raw;
			try {
				raw = await Promise.race([this.transport.receive(), readCanceled.promise]);
			} finally {
				if (this.cancelReadLoop === readCanceled.reject) this.cancelReadLoop = void 0;
			}
			if (this.encodingLevel === "string" && raw.length > this.limits.maxMessageSize) throw new TypeError(`Incoming message exceeds maximum size of ${this.limits.maxMessageSize} UTF-16 code units.`);
			if (this.abortReason) break;
			let msg = this.encodingLevel === "string" ? JSON.parse(raw) : raw;
			if (msg instanceof Array) switch (msg[0]) {
				case "push":
					if (msg.length > 1) {
						let hook = new PayloadStubHook(new Evaluator(this, this.encodingLevel).evaluate(msg[1]));
						hook.ignoreUnhandledRejections();
						this.exports.push({
							hook,
							refcount: 1
						});
						continue;
					}
					break;
				case "stream":
					if (msg.length > 1) {
						let hook = new PayloadStubHook(new Evaluator(this, this.encodingLevel).evaluate(msg[1]));
						hook.ignoreUnhandledRejections();
						let exportId = this.exports.length;
						this.exports.push({
							hook,
							refcount: 1,
							autoRelease: true
						});
						this.ensureResolvingExport(exportId);
						continue;
					}
					break;
				case "pipe": {
					let { readable, writable } = new TransformStream();
					let hook = streamImpl.createWritableStreamHook(writable);
					this.exports.push({
						hook,
						refcount: 1,
						pipeReadable: readable
					});
					continue;
				}
				case "pull": {
					let exportId = msg[1];
					if (typeof exportId == "number") {
						this.ensureResolvingExport(exportId);
						continue;
					}
					break;
				}
				case "resolve":
				case "reject": {
					let importId = msg[1];
					if (typeof importId == "number" && msg.length > 2) {
						let imp = this.imports[importId];
						if (imp) if (msg[0] == "resolve") imp.resolve(new PayloadStubHook(new Evaluator(this, this.encodingLevel).evaluate(msg[2])));
						else {
							let payload = new Evaluator(this, this.encodingLevel).evaluate(msg[2]);
							payload.dispose();
							imp.resolve(new ErrorStubHook(payload.value));
						}
						else if (msg[0] == "resolve") new Evaluator(this, this.encodingLevel).evaluate(msg[2]).dispose();
						continue;
					}
					break;
				}
				case "release": {
					let exportId = msg[1];
					let refcount = msg[2];
					if (typeof exportId == "number" && typeof refcount == "number") {
						this.releaseExport(exportId, refcount);
						continue;
					}
					break;
				}
				case "abort": {
					let payload = new Evaluator(this, this.encodingLevel).evaluate(msg[1]);
					payload.dispose();
					this.abort(payload.value, false);
					break;
				}
			}
			throw new Error(`bad RPC message: ${JSON.stringify(msg)}`);
		}
	}
	async drain() {
		if (this.abortReason) throw this.abortReason;
		if (this.pullCount > 0) {
			let { promise, resolve, reject } = Promise.withResolvers();
			this.onBatchDone = {
				resolve,
				reject
			};
			await promise;
		}
	}
	getStats() {
		let result = {
			imports: 0,
			exports: 0
		};
		for (let i in this.imports) ++result.imports;
		for (let i in this.exports) ++result.exports;
		return result;
	}
};
var RpcSession$1 = class {
	#session;
	#mainStub;
	constructor(transport, localMain, options = {}) {
		let mainHook;
		if (localMain) mainHook = new PayloadStubHook(RpcPayload.fromAppReturn(localMain));
		else mainHook = new ErrorStubHook(/* @__PURE__ */ new Error("This connection has no main object."));
		this.#session = new RpcSessionImpl(transport, mainHook, options);
		this.#mainStub = new RpcStub$1(this.#session.getMainImport());
	}
	getRemoteMain() {
		return this.#mainStub;
	}
	getStats() {
		return this.#session.getStats();
	}
	drain() {
		return this.#session.drain();
	}
};

//#endregion
//#region src/websocket.ts
/** Close-frame reason max UTF-8 bytes: 125 payload - 2-byte status (RFC 6455 section 5.5). */
const MAX_CLOSE_REASON_BYTES = 123;
function newWebSocketRpcSession$1(webSocket, localMain, options) {
	if (typeof webSocket === "string") webSocket = new WebSocket(webSocket);
	return new RpcSession$1(new WebSocketTransport(webSocket), localMain, options).getRemoteMain();
}
/**
* For use in Cloudflare Workers: Construct an HTTP response that starts a WebSocket RPC session
* with the given `localMain`.
*/
function newWorkersWebSocketRpcResponse(request, localMain, options) {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
	let pair = new WebSocketPair();
	let server = pair[0];
	server.accept();
	newWebSocketRpcSession$1(server, localMain, options);
	return new Response(null, {
		status: 101,
		webSocket: pair[1]
	});
}
/**
* Generic WebSocket transport. Default `T = string` is backward-compatible and satisfies
* `RpcTransport`. Use `T = ArrayBuffer` as a building block for binary transports.
*/
var WebSocketTransport = class {
	constructor(webSocket) {
		this.#webSocket = webSocket;
		webSocket.binaryType = "arraybuffer";
		if (webSocket.readyState === WebSocket.CONNECTING) {
			this.#sendQueue = [];
			webSocket.addEventListener("open", (event) => {
				try {
					for (let message of this.#sendQueue) webSocket.send(message);
				} catch (err) {
					this.#receivedError(err);
				}
				this.#sendQueue = void 0;
			});
		}
		webSocket.addEventListener("message", (event) => {
			if (this.#error) {} else if (typeof event.data === "string" || event.data instanceof ArrayBuffer) if (this.#receiveResolver) {
				this.#receiveResolver(event.data);
				this.#receiveResolver = void 0;
				this.#receiveRejecter = void 0;
			} else this.#receiveQueue.push(event.data);
			else this.#receivedError(/* @__PURE__ */ new TypeError("Received unexpected message type from WebSocket."));
		});
		webSocket.addEventListener("close", (event) => {
			this.#receivedError(/* @__PURE__ */ new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`));
		});
		webSocket.addEventListener("error", (event) => {
			this.#receivedError(/* @__PURE__ */ new Error(`WebSocket connection failed.`));
		});
	}
	#webSocket;
	#sendQueue;
	#receiveResolver;
	#receiveRejecter;
	#receiveQueue = [];
	#error;
	send(message) {
		if (this.#sendQueue === void 0) this.#webSocket.send(message);
		else this.#sendQueue.push(message);
	}
	receive() {
		if (this.#receiveQueue.length > 0) return Promise.resolve(this.#receiveQueue.shift());
		else if (this.#error) return Promise.reject(this.#error);
		else return new Promise((resolve, reject) => {
			this.#receiveResolver = resolve;
			this.#receiveRejecter = reject;
		});
	}
	abort(reason) {
		let message;
		if (reason instanceof Error) message = reason.message;
		else message = `${reason}`;
		let reasonBytes = new TextEncoder().encode(message);
		if (reasonBytes.length > 123) message = new TextDecoder().decode(reasonBytes.subarray(0, 123), { stream: true });
		this.#webSocket.close(3e3, message);
		if (!this.#error) this.#error = reason;
	}
	#receivedError(reason) {
		if (!this.#error) {
			this.#error = reason;
			if (this.#receiveRejecter) {
				this.#receiveRejecter(reason);
				this.#receiveResolver = void 0;
				this.#receiveRejecter = void 0;
			}
		}
	}
};

//#endregion
//#region src/batch.ts
const yieldToMacrotask = typeof setImmediate === "function" ? () => new Promise((resolve) => setImmediate(resolve)) : () => new Promise((resolve) => setTimeout(resolve, 0));
var BatchClientTransport = class {
	constructor(sendBatch) {
		this.#promise = this.#scheduleBatch(sendBatch);
	}
	#promise;
	#aborted;
	#batchToSend = [];
	#batchToReceive = null;
	send(message) {
		if (this.#batchToSend !== null) this.#batchToSend.push(message);
	}
	async receive() {
		if (!this.#batchToReceive) await this.#promise;
		let msg = this.#batchToReceive.shift();
		if (msg !== void 0) return msg;
		else throw new Error("Batch RPC request ended.");
	}
	abort(reason) {
		this.#aborted = reason;
	}
	async #scheduleBatch(sendBatch) {
		await yieldToMacrotask();
		if (this.#aborted !== void 0) throw this.#aborted;
		let batch = this.#batchToSend;
		this.#batchToSend = null;
		this.#batchToReceive = await sendBatch(batch);
	}
};
function newHttpBatchRpcSession$1(urlOrRequest, options) {
	let sendBatch = async (batch) => {
		let response = await fetch(urlOrRequest, {
			method: "POST",
			body: batch.join("\n")
		});
		if (!response.ok) {
			response.body?.cancel();
			throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
		}
		let body = await response.text();
		return body == "" ? [] : body.split("\n");
	};
	return new RpcSession$1(new BatchClientTransport(sendBatch), void 0, options).getRemoteMain();
}
var BatchServerTransport = class {
	constructor(batch) {
		this.#batchToReceive = batch;
	}
	#batchToSend = [];
	#batchToReceive;
	#allReceived = Promise.withResolvers();
	send(message) {
		this.#batchToSend.push(message);
	}
	async receive() {
		let msg = this.#batchToReceive.shift();
		if (msg !== void 0) return msg;
		else {
			this.#allReceived.resolve();
			return new Promise((r) => {});
		}
	}
	abort(reason) {
		this.#allReceived.reject(reason);
	}
	whenAllReceived() {
		return this.#allReceived.promise;
	}
	getResponseBody() {
		return this.#batchToSend.join("\n");
	}
};
/**
* Implements the server end of an HTTP batch session, using standard Fetch API types to represent
* HTTP requests and responses.
*
* @param request The request received from the client initiating the session.
* @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
* @param options Optional RPC session options.
* @returns The HTTP response to return to the client. Note that the returned object has mutable
*     headers, so you can modify them using e.g. `response.headers.set("Foo", "bar")`.
*/
async function newHttpBatchRpcResponse(request, localMain, options) {
	if (request.method !== "POST") return new Response("This endpoint only accepts POST requests.", { status: 405 });
	let body = await request.text();
	let transport = new BatchServerTransport(body === "" ? [] : body.split("\n"));
	let rpc = new RpcSession$1(transport, localMain, options);
	await transport.whenAllReceived();
	await rpc.drain();
	return new Response(transport.getResponseBody());
}
/**
* Implements the server end of an HTTP batch session using traditional Node.js HTTP APIs.
*
* @param request The request received from the client initiating the session.
* @param response The response object, to which the response should be written.
* @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
* @param options Optional RPC session options. You can also pass headers to set on the response.
*/
async function nodeHttpBatchRpcResponse(request, response, localMain, options) {
	if (request.method !== "POST") {
		response.writeHead(405, "This endpoint only accepts POST requests.", options?.headers);
		response.end();
		return;
	}
	let body = await new Promise((resolve, reject) => {
		let chunks = [];
		request.on("data", (chunk) => {
			chunks.push(chunk);
		});
		request.on("end", () => {
			resolve(Buffer.concat(chunks).toString());
		});
		request.on("error", reject);
	});
	let transport = new BatchServerTransport(body === "" ? [] : body.split("\n"));
	let rpc = new RpcSession$1(transport, localMain, options);
	await transport.whenAllReceived();
	await rpc.drain();
	response.writeHead(200, options?.headers);
	response.end(transport.getResponseBody());
}

//#endregion
//#region src/messageport.ts
function newMessagePortRpcSession$1(port, localMain, options) {
	return new RpcSession$1(new MessagePortTransport(port), localMain, options).getRemoteMain();
}
var MessagePortTransport = class {
	encodingLevel = "structuredClonable";
	constructor(port) {
		this.#port = port;
		port.start();
		port.addEventListener("message", (event) => {
			if (this.#error) {} else if (event.data === null) this.#receivedError(/* @__PURE__ */ new Error("Peer closed MessagePort connection."));
			else if (this.#receiveResolver) {
				this.#receiveResolver(event.data);
				this.#receiveResolver = void 0;
				this.#receiveRejecter = void 0;
			} else this.#receiveQueue.push(event.data);
		});
		port.addEventListener("messageerror", (event) => {
			this.#receivedError(/* @__PURE__ */ new Error("MessagePort message error."));
		});
	}
	#port;
	#receiveResolver;
	#receiveRejecter;
	#receiveQueue = [];
	#error;
	send(message) {
		if (this.#error) throw this.#error;
		this.#port.postMessage(message);
	}
	async receive() {
		if (this.#receiveQueue.length > 0) return this.#receiveQueue.shift();
		else if (this.#error) throw this.#error;
		else return new Promise((resolve, reject) => {
			this.#receiveResolver = resolve;
			this.#receiveRejecter = reject;
		});
	}
	abort(reason) {
		try {
			this.#port.postMessage(null);
		} catch (err) {}
		this.#port.close();
		if (!this.#error) this.#error = reason;
	}
	#receivedError(reason) {
		if (!this.#error) {
			this.#error = reason;
			if (this.#receiveRejecter) {
				this.#receiveRejecter(reason);
				this.#receiveResolver = void 0;
				this.#receiveRejecter = void 0;
			}
		}
	}
};

//#endregion
//#region src/map.ts
let currentMapBuilder;
var MapBuilder = class {
	context;
	captureMap = /* @__PURE__ */ new Map();
	instructions = [];
	constructor(subject, path) {
		if (currentMapBuilder) this.context = {
			parent: currentMapBuilder,
			captures: [],
			subject: currentMapBuilder.capture(subject),
			path
		};
		else this.context = {
			parent: void 0,
			captures: [],
			subject,
			path
		};
		currentMapBuilder = this;
	}
	unregister() {
		currentMapBuilder = this.context.parent;
	}
	makeInput() {
		return new MapVariableHook(this, 0);
	}
	makeOutput(result) {
		let devalued;
		try {
			devalued = Devaluator.devaluate(result.value, void 0, this, result);
		} finally {
			result.dispose();
		}
		this.instructions.push(devalued);
		if (this.context.parent) {
			this.context.parent.instructions.push([
				"remap",
				this.context.subject,
				this.context.path,
				this.context.captures.map((cap) => ["import", cap]),
				this.instructions
			]);
			return new MapVariableHook(this.context.parent, this.context.parent.instructions.length);
		} else return this.context.subject.map(this.context.path, this.context.captures, this.instructions);
	}
	pushCall(hook, path, params) {
		let devalued = Devaluator.devaluate(params.value, void 0, this, params);
		devalued = devalued[0];
		let subject = this.capture(hook.dup());
		this.instructions.push([
			"pipeline",
			subject,
			path,
			devalued
		]);
		return new MapVariableHook(this, this.instructions.length);
	}
	pushGet(hook, path) {
		let subject = this.capture(hook.dup());
		this.instructions.push([
			"pipeline",
			subject,
			path
		]);
		return new MapVariableHook(this, this.instructions.length);
	}
	capture(hook) {
		if (hook instanceof MapVariableHook && hook.mapper === this) return hook.idx;
		let result = this.captureMap.get(hook);
		if (result === void 0) {
			if (this.context.parent) {
				let parentIdx = this.context.parent.capture(hook);
				this.context.captures.push(parentIdx);
			} else this.context.captures.push(hook);
			result = -this.context.captures.length;
			this.captureMap.set(hook, result);
		}
		return result;
	}
	exportStub(hook) {
		throw new Error("Can't construct an RpcTarget or RPC callback inside a mapper function. Try creating a new RpcStub outside the callback first, then using it inside the callback.");
	}
	exportPromise(hook) {
		return this.exportStub(hook);
	}
	getImport(hook) {
		return this.capture(hook);
	}
	unexport(ids) {}
	createPipe(readable) {
		throw new Error("Cannot send ReadableStream inside a mapper function.");
	}
	onSendError(error) {}
};
mapImpl.sendMap = (hook, path, func) => {
	let builder = new MapBuilder(hook, path);
	let result;
	try {
		result = RpcPayload.fromAppReturn(withCallInterceptor(builder.pushCall.bind(builder), () => {
			return func(new RpcPromise$1(builder.makeInput(), []));
		}));
	} finally {
		builder.unregister();
	}
	if (result instanceof Promise) {
		result.catch((err) => {});
		throw new Error("RPC map() callbacks cannot be async.");
	}
	return new RpcPromise$1(builder.makeOutput(result), []);
};
function throwMapperBuilderUseError() {
	throw new Error("Attempted to use an abstract placeholder from a mapper function. Please make sure your map function has no side effects.");
}
var MapVariableHook = class extends StubHook {
	mapper;
	idx;
	constructor(mapper, idx) {
		super();
		this.mapper = mapper;
		this.idx = idx;
	}
	dup() {
		return this;
	}
	dispose() {}
	get(path) {
		if (path.length == 0) return this;
		else if (currentMapBuilder) return currentMapBuilder.pushGet(this, path);
		else throwMapperBuilderUseError();
	}
	call(path, args) {
		args.dispose();
		throwMapperBuilderUseError();
	}
	map(path, captures, instructions) {
		for (let cap of captures) cap.dispose();
		throwMapperBuilderUseError();
	}
	pull() {
		throwMapperBuilderUseError();
	}
	ignoreUnhandledRejections() {}
	onBroken(callback) {
		throwMapperBuilderUseError();
	}
};
var MapApplicator = class {
	captures;
	variables;
	constructor(captures, input) {
		this.captures = captures;
		this.variables = [input];
	}
	dispose() {
		for (let variable of this.variables) variable.dispose();
	}
	apply(instructions) {
		try {
			if (instructions.length < 1) throw new Error("Invalid empty mapper function.");
			for (let instruction of instructions.slice(0, -1)) {
				let payload = new Evaluator(this).evaluateCopy(instruction);
				if (payload.value instanceof RpcStub$1) {
					let hook = unwrapStubNoProperties(payload.value);
					if (hook) {
						this.variables.push(hook);
						continue;
					}
				}
				this.variables.push(new PayloadStubHook(payload));
			}
			return new Evaluator(this).evaluateCopy(instructions[instructions.length - 1]);
		} finally {
			for (let variable of this.variables) variable.dispose();
		}
	}
	importStub(idx) {
		throw new Error("A mapper function cannot refer to exports.");
	}
	importPromise(idx) {
		return this.importStub(idx);
	}
	getExport(idx) {
		if (idx < 0) return this.captures[-idx - 1];
		else return this.variables[idx];
	}
	getPipeReadable(exportId) {
		throw new Error("A mapper function cannot use pipe readables.");
	}
	getLimits() {
		return DEFAULT_LIMITS;
	}
};
function applyMapToElement(input, parent, owner, captures, instructions) {
	let mapper = new MapApplicator(captures, new PayloadStubHook(RpcPayload.deepCopyFrom(input, parent, owner)));
	try {
		return mapper.apply(instructions);
	} finally {
		mapper.dispose();
	}
}
mapImpl.applyMap = (input, parent, owner, captures, instructions) => {
	try {
		let result;
		if (input instanceof RpcPromise$1) throw new Error("applyMap() can't be called on RpcPromise");
		else if (input instanceof Array) {
			let payloads = [];
			try {
				for (let elem of input) payloads.push(applyMapToElement(elem, input, owner, captures, instructions));
			} catch (err) {
				for (let payload of payloads) payload.dispose();
				throw err;
			}
			result = RpcPayload.fromArray(payloads);
		} else if (input === null || input === void 0) result = RpcPayload.fromAppReturn(input);
		else result = applyMapToElement(input, parent, owner, captures, instructions);
		return new PayloadStubHook(result);
	} finally {
		for (let cap of captures) cap.dispose();
	}
};

//#endregion
//#region src/streams.ts
var WritableStreamStubHook = class WritableStreamStubHook extends StubHook {
	state;
	static create(stream) {
		return new WritableStreamStubHook({
			refcount: 1,
			writer: stream.getWriter(),
			closed: false
		});
	}
	constructor(state, dupFrom) {
		super();
		this.state = state;
		if (dupFrom) ++state.refcount;
	}
	getState() {
		if (this.state) return this.state;
		else throw new Error("Attempted to use a WritableStreamStubHook after it was disposed.");
	}
	call(path, args) {
		try {
			let state = this.getState();
			if (path.length !== 1 || typeof path[0] !== "string") throw new Error("WritableStream stub only supports direct method calls");
			const method = path[0];
			if (method !== "write" && method !== "close" && method !== "abort") throw new Error(`Unknown WritableStream method: ${method}`);
			if (method === "close" || method === "abort") state.closed = true;
			return new PromiseStubHook((method === "write" ? args.deliverStreamWrite(state.writer) : args.deliverCall(state.writer[method], state.writer)).then((payload) => new PayloadStubHook(payload)));
		} catch (err) {
			args.dispose();
			return new ErrorStubHook(err);
		}
	}
	map(path, captures, instructions) {
		for (let cap of captures) cap.dispose();
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot use map() on a WritableStream"));
	}
	get(path) {
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot access properties on a WritableStream stub"));
	}
	dup() {
		return new WritableStreamStubHook(this.getState(), this);
	}
	pull() {
		return Promise.reject(/* @__PURE__ */ new Error("Cannot pull a WritableStream stub"));
	}
	ignoreUnhandledRejections() {}
	dispose() {
		let state = this.state;
		this.state = void 0;
		if (state) {
			if (--state.refcount === 0) {
				if (!state.closed) state.writer.abort(/* @__PURE__ */ new Error("WritableStream RPC stub was disposed without calling close()")).catch(() => {});
				state.writer.releaseLock();
			}
		}
	}
	onBroken(callback) {}
};
const INITIAL_WINDOW = 256 * 1024;
const MAX_WINDOW = 1024 * 1024 * 1024;
const MIN_WINDOW = 64 * 1024;
const STARTUP_GROWTH_FACTOR = 2;
const STEADY_GROWTH_FACTOR = 1.25;
const DECAY_FACTOR = .9;
const STARTUP_EXIT_ROUNDS = 3;
var FlowController = class {
	now;
	window = INITIAL_WINDOW;
	bytesInFlight = 0;
	inStartupPhase = true;
	delivered = 0;
	deliveredTime = 0;
	firstAckTime = 0;
	firstAckDelivered = 0;
	minRtt = Infinity;
	roundsWithoutIncrease = 0;
	lastRoundWindow = 0;
	roundStartTime = 0;
	constructor(now) {
		this.now = now;
	}
	onSend(size) {
		this.bytesInFlight += size;
		let token = {
			sentTime: this.now(),
			size,
			deliveredAtSend: this.delivered,
			deliveredTimeAtSend: this.deliveredTime,
			windowAtSend: this.window,
			windowFullAtSend: this.bytesInFlight >= this.window
		};
		return {
			token,
			shouldBlock: token.windowFullAtSend
		};
	}
	onError(token) {
		this.bytesInFlight -= token.size;
	}
	onAck(token) {
		let ackTime = this.now();
		this.delivered += token.size;
		this.deliveredTime = ackTime;
		this.bytesInFlight -= token.size;
		let rtt = ackTime - token.sentTime;
		this.minRtt = Math.min(this.minRtt, rtt);
		if (this.firstAckTime === 0) {
			this.firstAckTime = ackTime;
			this.firstAckDelivered = this.delivered;
		} else {
			let baseTime;
			let baseDelivered;
			if (token.deliveredTimeAtSend === 0) {
				baseTime = this.firstAckTime;
				baseDelivered = this.firstAckDelivered;
			} else {
				baseTime = token.deliveredTimeAtSend;
				baseDelivered = token.deliveredAtSend;
			}
			let interval = ackTime - baseTime;
			let bandwidth = (this.delivered - baseDelivered) / interval;
			let growthFactor = this.inStartupPhase ? STARTUP_GROWTH_FACTOR : STEADY_GROWTH_FACTOR;
			let newWindow = bandwidth * this.minRtt * growthFactor;
			newWindow = Math.min(newWindow, token.windowAtSend * growthFactor);
			if (token.windowFullAtSend) newWindow = Math.max(newWindow, token.windowAtSend * DECAY_FACTOR);
			else newWindow = Math.max(newWindow, this.window);
			this.window = Math.max(Math.min(newWindow, MAX_WINDOW), MIN_WINDOW);
			if (this.inStartupPhase && token.sentTime >= this.roundStartTime) {
				if (this.window > this.lastRoundWindow * STEADY_GROWTH_FACTOR) this.roundsWithoutIncrease = 0;
				else if (++this.roundsWithoutIncrease >= STARTUP_EXIT_ROUNDS) this.inStartupPhase = false;
				this.roundStartTime = ackTime;
				this.lastRoundWindow = this.window;
			}
		}
		return this.bytesInFlight < this.window;
	}
};
function createWritableStreamFromHook(hook) {
	let pendingError = void 0;
	let hookDisposed = false;
	let fc = new FlowController(() => performance.now());
	let windowResolve;
	let windowReject;
	const disposeHook = () => {
		if (!hookDisposed) {
			hookDisposed = true;
			hook.dispose();
		}
	};
	return new WritableStream({
		write(chunk, controller) {
			if (pendingError !== void 0) throw pendingError;
			const payload = RpcPayload.fromAppParams([chunk]);
			const { promise, size } = hook.stream(["write"], payload);
			if (size === void 0) return promise.catch((err) => {
				if (pendingError === void 0) pendingError = err;
				throw err;
			});
			else {
				let { token, shouldBlock } = fc.onSend(size);
				promise.then(() => {
					if (fc.onAck(token) && windowResolve) {
						windowResolve();
						windowResolve = void 0;
						windowReject = void 0;
					}
				}, (err) => {
					fc.onError(token);
					if (pendingError === void 0) {
						pendingError = err;
						controller.error(err);
						disposeHook();
					}
					if (windowReject) {
						windowReject(err);
						windowResolve = void 0;
						windowReject = void 0;
					}
				});
				if (shouldBlock) return new Promise((resolve, reject) => {
					windowResolve = resolve;
					windowReject = reject;
				});
			}
		},
		async close() {
			if (pendingError !== void 0) {
				disposeHook();
				throw pendingError;
			}
			const { promise } = hook.stream(["close"], RpcPayload.fromAppParams([]));
			try {
				await promise;
			} catch (err) {
				throw pendingError ?? err;
			} finally {
				disposeHook();
			}
		},
		abort(reason) {
			if (pendingError !== void 0) return;
			pendingError = reason ?? /* @__PURE__ */ new Error("WritableStream was aborted");
			if (windowReject) {
				windowReject(pendingError);
				windowResolve = void 0;
				windowReject = void 0;
			}
			const { promise } = hook.stream(["abort"], RpcPayload.fromAppParams([reason]));
			promise.then(() => disposeHook(), () => disposeHook());
		}
	});
}
var ReadableStreamStubHook = class ReadableStreamStubHook extends StubHook {
	state;
	static create(stream) {
		return new ReadableStreamStubHook({
			refcount: 1,
			stream,
			canceled: false
		});
	}
	constructor(state, dupFrom) {
		super();
		this.state = state;
		if (dupFrom) ++state.refcount;
	}
	call(path, args) {
		args.dispose();
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot call methods on a ReadableStream stub"));
	}
	map(path, captures, instructions) {
		for (let cap of captures) cap.dispose();
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot use map() on a ReadableStream"));
	}
	get(path) {
		return new ErrorStubHook(/* @__PURE__ */ new Error("Cannot access properties on a ReadableStream stub"));
	}
	dup() {
		let state = this.state;
		if (!state) throw new Error("Attempted to dup a ReadableStreamStubHook after it was disposed.");
		return new ReadableStreamStubHook(state, this);
	}
	pull() {
		return Promise.reject(/* @__PURE__ */ new Error("Cannot pull a ReadableStream stub"));
	}
	ignoreUnhandledRejections() {}
	dispose() {
		let state = this.state;
		this.state = void 0;
		if (state) {
			if (--state.refcount === 0) {
				if (!state.canceled) {
					state.canceled = true;
					if (!state.stream.locked) state.stream.cancel(/* @__PURE__ */ new Error("ReadableStream RPC stub was disposed without being consumed")).catch(() => {});
				}
			}
		}
	}
	onBroken(callback) {}
};
streamImpl.createWritableStreamHook = WritableStreamStubHook.create;
streamImpl.createWritableStreamFromHook = createWritableStreamFromHook;
streamImpl.createReadableStreamHook = ReadableStreamStubHook.create;

//#endregion
//#region src/index.ts
const RpcStub = RpcStub$1;
const RpcPromise = RpcPromise$1;
const RpcSession = RpcSession$1;
const RpcTarget = RpcTarget$1;
/**
* Start a WebSocket session given either an already-open WebSocket or a URL.
*
* @param webSocket Either the `wss://` URL to connect to, or an already-open WebSocket object to
* use.
* @param localMain The main RPC interface to expose to the peer. Returns a stub for the main
* interface exposed from the peer.
*/
let newWebSocketRpcSession = newWebSocketRpcSession$1;
/**
* Initiate an HTTP batch session from the client side.
*
* The parameters to this method have exactly the same signature as `fetch()`, but the return
* value is an RpcStub. You can customize anything about the request except for the method
* (it will always be set to POST) and the body (which the RPC system will fill in).
*/
let newHttpBatchRpcSession = newHttpBatchRpcSession$1;
/**
* Initiate an RPC session over a MessagePort, which is particularly useful for communicating
* between an iframe and its parent frame in a browser context. Each side should call this function
* on its own end of the MessageChannel.
*/
let newMessagePortRpcSession = newMessagePortRpcSession$1;
/**
* Implements unified handling of HTTP-batch and WebSocket responses for the Cloudflare Workers
* Runtime.
*
* SECURITY WARNING: This function accepts cross-origin requests. If you do not want this, you
* should validate the `Origin` header before calling this, or use `newHttpBatchRpcSession()` and
* `newWebSocketRpcSession()` directly with appropriate security measures for each type of request.
* But if your API uses in-band authorization (i.e. it has an RPC method that takes the user's
* credentials as parameters and returns the authorized API), then cross-origin requests should
* be safe.
*/
async function newWorkersRpcResponse(request, localMain, options) {
	if (request.method === "POST") {
		let response = await newHttpBatchRpcResponse(request, localMain, options);
		response.headers.set("Access-Control-Allow-Origin", "*");
		return response;
	} else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return newWorkersWebSocketRpcResponse(request, localMain, options);
	else return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
}

//#endregion
