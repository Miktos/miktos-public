// Base interface for all AI model providers
import { AIModelRequest, AIModelResponse, Message, StreamChunk } from 'miktos-shared/types';

export interface ModelProvider {
  // Generate a text completion
  generate(params: AIModelRequest): Promise<AIModelResponse>;

  // Generate a streaming response
  generateStream?(params: AIModelRequest, streamId: string, onChunk: (chunk: StreamChunk) => void): Promise<AIModelResponse>;
  
  // Convert messages array to provider-specific format
  formatMessages(messages: Message[], systemPrompt?: string): any;
  
  // Count tokens for a given prompt
  countTokens(text: string): Promise<number>;
  
  // Check if provider/model is available (has valid API key, etc.)
  isAvailable(): Promise<boolean>;
}

export abstract class BaseModelProvider implements ModelProvider {
  protected apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  abstract generate(params: AIModelRequest): Promise<AIModelResponse>;
  
  async generateStream(params: AIModelRequest, streamId: string, onChunk: (chunk: StreamChunk) => void): Promise<AIModelResponse> {
    // Default implementation: fall back to non-streaming generate and send a single chunk.
    // Providers should override this with true streaming logic if available.
    const response = await this.generate(params);
    onChunk({
      streamId,
      chunkId: params.requestId || `${streamId}-${new Date().toISOString()}`,
      type: 'content_delta',
      payload: { text: response.content }, // Assuming response.content is the full text
      timestamp: new Date(),
      isFinal: true,
      modelId: response.modelId,
      metadata: { usage: response.usage, provider: response.provider }
    });
    return response; 
  }
  abstract formatMessages(messages: Message[], systemPrompt?: string): any;
  abstract countTokens(text: string): Promise<number>;
  
  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }
}
