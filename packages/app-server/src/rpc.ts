import { isRecord, rpcRequestSchema, ServiceError } from '@weiguangchao/codexplus-shared';
import type { RpcId, RpcResponse } from '@weiguangchao/codexplus-shared';

export class RpcError extends Error {
  readonly code: number;
  constructor({ code, message }: { code: number; message: string }) {
    super(message);
    this.code = code;
  }
}

export function rpcError({ id, error }: { id: RpcId; error: unknown }): RpcResponse {
  if (error instanceof RpcError) {
    return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
  }
  if (error instanceof ServiceError) {
    return { jsonrpc: '2.0', id, error: { code: error.status === 400 ? -32602 : -32000,
      message: error.message, data: { ...(isRecord(error.details) ? error.details : {}), status: error.status } } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32603, message: '服务端操作失败，请检查服务端文件权限和配置。' } };
}

export async function dispatchRpc({ value, invoke }: { value: unknown; invoke: (options: { method: string; params: unknown }) => Promise<unknown> }): Promise<RpcResponse | RpcResponse[] | undefined> {
  async function dispatch(request: unknown): Promise<RpcResponse | undefined> {
    const parsed = rpcRequestSchema.safeParse(request);
    if (!parsed.success) {
      return rpcError({ id: null, error: new RpcError({ code: -32600, message: 'JSON-RPC 请求格式无效。' }) });
    }
    const { id, method, params } = parsed.data;
    try {
      const result = await invoke({ method, params: params ?? {} });
      return id === undefined ? undefined : { jsonrpc: '2.0', id, result };
    } catch (error) {
      return id === undefined ? undefined : rpcError({ id, error });
    }
  }

  if (!Array.isArray(value)) return await dispatch(value);
  if (value.length === 0) return rpcError({ id: null, error: new RpcError({ code: -32600, message: 'JSON-RPC 批量请求不能为空。' }) });
  const responses: RpcResponse[] = [];
  for (const request of value) {
    const response = await dispatch(request);
    if (response !== undefined) responses.push(response);
  }
  return responses.length === 0 ? undefined : responses;
}
