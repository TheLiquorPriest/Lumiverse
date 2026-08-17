import { post, put, type RequestOptions } from './client'
import type {
  ChatAgentModeWriteResponseV1,
  ChatAgentModeWriteV1,
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
} from '@/types/effective-runtime'

export const effectiveRuntimeApi = {
  resolve(request: EffectiveRuntimeRequestV1, options?: RequestOptions) {
    return post<EffectiveRuntimePublicResponseV1>('/generate/effective-runtime', request, options)
  },

  setChatMode(chatId: string, input: ChatAgentModeWriteV1) {
    return put<ChatAgentModeWriteResponseV1>(`/chats/${chatId}/agent-mode`, input)
  },
}
