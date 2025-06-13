// Google AI implementation of the model provider interface
import { DiscussServiceClient } from '@google-ai/generativelanguage';
import { GoogleAuth } from 'google-auth-library';
import { BaseModelProvider } from './baseProvider';
import { AIModelRequest, AIModelResponse, Message, MessageRole, ContentBlock, ContentBlockType, StreamChunk } from 'miktos-shared/types';
import { MODEL_IDS } from 'miktos-shared/constants';

export class GoogleAIProvider extends BaseModelProvider {
  private client: DiscussServiceClient;
  
  constructor(apiKey: string) {
    super(apiKey);
    
    // Initialize the Google AI client with API key
    this.client = new DiscussServiceClient({
      authClient: new GoogleAuth().fromAPIKey(apiKey),
    });
  }
  
  async generate(params: AIModelRequest): Promise<AIModelResponse> {
    const maxRetries = 3;
    let retries = 0;
    let delay = 1000; // Start with 1s delay
    
    while (retries <= maxRetries) {
      try {
        const { modelId, temperature = 0.7, maxTokens, prompt } = params;
        
        // For a simple text completion without a chat history
        if (!Array.isArray(prompt)) {
          const response = await this.client.generateMessage({
            model: this.formatModelName(modelId),
            prompt: {
              messages: [{ content: prompt as string }],
            },
            temperature,
            candidateCount: 1,
            topK: 40,
            topP: 0.95,
          });
          
          const content = response[0]?.candidates?.[0]?.content || '';
          
          // Google doesn't provide detailed token usage info in the same format
          // so we'll estimate based on input/output length
          const inputTokens = await this.countTokens(prompt);
          const outputTokens = await this.countTokens(content);
          
          return {
            modelId,
            provider: 'google',
            content,
            usage: {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
              estimatedCost: this.calculateCost(modelId, inputTokens, outputTokens),
            },
            metadata: {
              finishReason: (response[0]?.candidates?.[0] as any)?.finishReason || null,
            }
          };
        } else {
          // Handle case where prompt is an array of messages
          const formattedMessages = this.formatMessages(prompt as unknown as Message[]);
          
          const response = await this.client.generateMessage({
            model: this.formatModelName(modelId),
            prompt: {
              messages: formattedMessages,
            },
            temperature,
            candidateCount: 1,
            topK: 40,
            topP: 0.95,
          });
          
          const content = response[0]?.candidates?.[0]?.content || '';
          
          // Calculate token usage
          let totalInputTokens = 0;
          for (const message of prompt as unknown as Message[]) {
            // Convert ContentBlock[] to string
            const contentText = this.getTextFromContentBlocks(message.content);
            totalInputTokens += await this.countTokens(contentText);
          }
          const outputTokens = await this.countTokens(content);
          
          return {
            modelId,
            provider: 'google',
            content,
            usage: {
              promptTokens: totalInputTokens,
              completionTokens: outputTokens,
              totalTokens: totalInputTokens + outputTokens,
              estimatedCost: this.calculateCost(modelId, totalInputTokens, outputTokens),
            },
            metadata: {
              finishReason: (response[0]?.candidates?.[0] as any)?.finishReason || null,
            }
          };
        }
      } catch (error) {
        // Check if it's a rate limit error (usually contains 'quota' or 'rate' in the message)
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isRateLimitError = errorMessage.toLowerCase().includes('quota') || 
                                errorMessage.toLowerCase().includes('rate') ||
                                errorMessage.toLowerCase().includes('limit');
        
        if (isRateLimitError && retries < maxRetries) {
          console.warn(`Google AI API rate limit hit, retrying in ${delay}ms... (Attempt ${retries + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retries++;
          delay *= 2; // Exponential backoff
          continue;
        }
        
        console.error('Google AI API Error:', error);
        throw new Error(`Google AI API Error: ${errorMessage}`);
      }
    }
    
    // If we've exhausted all retries and still failed
    throw new Error('Google AI API Error: Maximum retry limit reached');
  }
  
  async generateStream(params: AIModelRequest, streamId: string, onChunk: (chunk: StreamChunk) => void): Promise<AIModelResponse> {
    try {
      const { modelId, temperature = 0.7, maxTokens, prompt } = params;
      
      // Google AI doesn't support true streaming, so we'll use the non-streaming API and simulate streaming
      const response = await this.generate(params);
      
      // Simulate streaming by breaking the response into smaller chunks
      const text = response.content;
      const chunkSize = 10; // Characters per chunk
      let sentChars = 0;
      
      // Send content in small chunks to simulate streaming
      while (sentChars < text.length) {
        const chunk = text.substring(sentChars, sentChars + chunkSize);
        sentChars += chunkSize;
        
        onChunk({
          streamId,
          chunkId: `${streamId}-${Date.now()}`,
          type: 'content_delta',
          payload: { text: chunk },
          timestamp: new Date(),
          isFinal: sentChars >= text.length,
          modelId: response.modelId,
          metadata: sentChars >= text.length ? { usage: response.usage } : undefined
        });
        
        // Add a small delay to simulate real-time streaming
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      return response;
    } catch (error) {
      console.error('Google AI Streaming Error:', error);
      
      // Send error chunk
      onChunk({
        streamId,
        chunkId: `${streamId}-error-${Date.now()}`,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
        timestamp: new Date(),
        isFinal: true,
        modelId: params.modelId,
        metadata: { provider: 'google' }
      });
      
      throw new Error(`Google AI Streaming Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  formatMessages(messages: Message[], systemPrompt?: string): any {
    // Convert Miktos message format to Google AI format
    return messages.map(message => {
      // Convert ContentBlock[] to plain text format
      const contentText = this.getTextFromContentBlocks(message.content);
      
      return {
        content: contentText,
        // Google AI uses 'author' instead of 'role'
        author: this.mapRoleToAuthor(message.role),
      };
    });
  }
  
  // Helper to map Miktos roles to Google AI author values
  private mapRoleToAuthor(role: MessageRole): string {
    switch (role) {
      case MessageRole.USER:
        return 'user';
      case MessageRole.ASSISTANT:
        return 'model';
      case MessageRole.SYSTEM:
        return 'system';
      case MessageRole.TOOL:
        return 'user'; // Google AI doesn't have a direct equivalent for tool messages
      default:
        return 'user';
    }
  }
  
  // Helper to format model names to Google's format if needed
  private formatModelName(modelId: string): string {
    // Add proper model name prefix if needed
    if (!modelId.includes('/')) {
      return `models/${modelId}`;
    }
    return modelId;
  }
  
  async countTokens(text: string): Promise<number> {
    try {
      // This is a simple approximation - in a real implementation,
      // you might use a proper tokenizer
      return Math.ceil(text.length / 4);
    } catch (error) {
      console.error('Token counting error:', error);
      // Return an approximation if tokenization fails
      return Math.ceil(text.length / 4);
    }
  }
  
  /**
   * Extracts text content from ContentBlock array
   * @param blocks Array of ContentBlock objects
   * @returns Text content joined as a single string
   */
  private getTextFromContentBlocks(blocks: any[]): string {
    if (Array.isArray(blocks)) {
      return blocks.map(block => {
        if (block.type === ContentBlockType.TEXT && block.text) {
          return block.text;
        } else if (block.type === ContentBlockType.CODE && block.code) {
          return `\`\`\`${block.language || ''}\n${block.code}\n\`\`\``;
        } else if (block.type === ContentBlockType.TOOL_USE && block.toolName) {
          return `[Tool use: ${block.toolName}]`;
        } else if (block.type === ContentBlockType.TOOL_RESULT) {
          return `[Tool result: ${JSON.stringify(block.result)}]`;
        } else if (block.type === ContentBlockType.IMAGE && block.caption) {
          return `[Image: ${block.caption}]`;
        } else {
          // For other block types or fallback
          return `[${block.type || 'unknown'} content]`;
        }
      }).join('\n');
    } else if (typeof blocks === 'string') {
      // Fallback for legacy handling - if somehow content is already a string
      return blocks;
    }
    return '';
  }
  
  private calculateCost(modelId: string, promptTokens: number, completionTokens: number): number {
    // Cost estimates in USD per 1K tokens
    const costs: Record<string, { input: number, output: number }> = {
      [MODEL_IDS.GEMINI_PRO]: { input: 0.00125, output: 0.00375 },
      [MODEL_IDS.GEMINI_ULTRA]: { input: 0.00375, output: 0.01125 },
    };
    
    const modelCost = costs[modelId] || costs[MODEL_IDS.GEMINI_PRO];
    
    const inputCost = (promptTokens / 1000) * modelCost.input;
    const outputCost = (completionTokens / 1000) * modelCost.output;
    
    return inputCost + outputCost;
  }
}