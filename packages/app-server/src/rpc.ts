import { isRecord, ServiceError } from '@weiguangchao/codexplus-shared';
import type { RpcId, RpcResponse } from '@weiguangchao/codexplus-shared';

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export function rpcError(id: RpcId, error: unknown): RpcResponse {
  if (error instanceof RpcError) {
    return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
  }
  if (error instanceof ServiceError) {
    return { jsonrpc: '2.0', id, error: { code: error.status === 400 ? -32602 : -32000,
      message: error.message, data: { ...error.details, status: error.status } } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32603, message: '服务端操作失败，请检查服务端文件权限和配置。' } };
}

export async function dispatchRpc(value: unknown, invoke: (method: string, params: unknown) => Promise<unknown>): Promise<RpcResponse | RpcResponse[] | undefined> {
  async function dispatch(request: unknown): Promise<RpcResponse | undefined> {
    if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      Object.hasOwn(request, 'id') && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number' ||
      Object.hasOwn(request, 'params') && !isRecord(request.params) && !Array.isArray(request.params)) {
      return rpcError(null, new RpcError(-32600, 'JSON-RPC 请求格式无效。'));
    }
    const id = request.id as RpcId | undefined;
    try {
      const result = await invoke(request.method, request.params ?? {});
      return id === undefined ? undefined : { jsonrpc: '2.0', id, result };
    } catch (error) {
      return id === undefined ? undefined : rpcError(id, error);
    }
  }

  if (!Array.isArray(value)) return await dispatch(value);
  if (value.length === 0) return rpcError(null, new RpcError(-32600, 'JSON-RPC 批量请求不能为空。'));
  const responses: RpcResponse[] = [];
  for (const request of value) {
    const response = await dispatch(request);
    if (response !== undefined) responses.push(response);
  }
  return responses.length === 0 ? undefined : responses;
}
