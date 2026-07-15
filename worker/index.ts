import handler from "vinext/server/app-router-entry";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: WorkerEnv, context: WorkerContext): Promise<Response> {
    return handler.fetch(request, env, context);
  },
};

export default worker;
