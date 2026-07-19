export type NormalizedAttachment = { filename: string; mediaType: string; data: string /* base64 */ }
export type NormalizedMessage = {
  role: 'user' | 'assistant'
  text: string
  ts?: number // epoch ms
  attachments?: NormalizedAttachment[]
}
export type NormalizedChat = {
  service: 'claude' | 'chatgpt' | 'gemini'
  externalId: string
  title: string
  messages: NormalizedMessage[]
}
