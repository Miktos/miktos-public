// Anthropic Claude implementation of the model provider interface
import Anthropic from '@anthropic-ai/sdk';
// Import types from the library
import type { Messages } from '@anthropic-ai/sdk/resources';
import { BaseModelProvider } from './baseProvider';
import { AIModelRequest, AIModelResponse, Message, MessageRole, ContentBlock, ContentBlockType, StreamChunk } from 'miktos-shared/types';
import { MODEL_IDS } from 'miktos-shared/constants';
import { logger } from '../../utils/logger';

// Define the Anthropic types locally to avoid namespace issues
type AnthropicMessageParam = Messages.MessageParam;
type AnthropicContentBlock = {
  type: string;
  text?: string;
};

export class AnthropicProvider extends BaseModelProvider {
  private client: Anthropic;
  
  constructor(apiKey: string) {
    super(apiKey);
    
    // Add fetch polyfill for environments where it's not available (like Node.js test environments)
    const clientOptions: any = { apiKey };
    if (typeof globalThis.fetch === 'undefined') {
      // Use a minimal fetch implementation for test environments
      const nodeFetch = eval('require')('node-fetch');
      clientOptions.fetch = nodeFetch;
    }
    
    this.client = new Anthropic(clientOptions);
  }
  
  async generate(params: AIModelRequest): Promise<AIModelResponse> {
    try {
      const { modelId, temperature = 0.7, maxTokens, stopSequences, systemPrompt, prompt } = params;
      
      // For a simple text completion without a chat history
      if (!Array.isArray(prompt)) {
        const messages: AnthropicMessageParam[] = [
          { role: 'user', content: prompt }
        ];
        
        const response = await this.client.messages.create({
          model: modelId,
          messages,
          temperature,
          max_tokens: maxTokens || 1024, // SDK requires a max_tokens value
          stop_sequences: stopSequences,
          system: systemPrompt,
        });
        
        // Extract text from content blocks
        const content = this.extractTextFromContent(response.content);
        
        return {
          modelId,
          provider: 'anthropic',
          content,
          usage: {
            promptTokens: response.usage?.input_tokens || 0,
            completionTokens: response.usage?.output_tokens || 0,
            totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
            estimatedCost: this.calculateCost(modelId, response.usage?.input_tokens || 0, response.usage?.output_tokens || 0),
          },
          metadata: {
            stopReason: response.stop_reason,
          }
        };
      } else {
        // Handle case where prompt is an array of messages
        const formattedMessages = this.formatMessages(prompt as unknown as Message[], systemPrompt);
        
        const response = await this.client.messages.create({
          model: modelId,
          messages: formattedMessages,
          temperature,
          max_tokens: maxTokens || 1024, // SDK requires a max_tokens value
          stop_sequences: stopSequences,
          system: systemPrompt,
        });
        
        // Extract text from content blocks
        const content = this.extractTextFromContent(response.content);
        
        return {
          modelId,
          provider: 'anthropic',
          content,
          usage: {
            promptTokens: response.usage?.input_tokens || 0,
            completionTokens: response.usage?.output_tokens || 0,
            totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
            estimatedCost: this.calculateCost(modelId, response.usage?.input_tokens || 0, response.usage?.output_tokens || 0),
          },
          metadata: {
            stopReason: response.stop_reason,
          }
        };
      }
    } catch (error) {
      logger.error('Anthropic API Error:', error);
      throw new Error(`Anthropic API Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async generateStream(params: AIModelRequest, streamId: string, onChunk: (chunk: StreamChunk) => void): Promise<AIModelResponse> {
    try {
      const { modelId, temperature = 0.7, maxTokens, stopSequences, systemPrompt, prompt } = params;
      
      let messages: AnthropicMessageParam[];
      let system = systemPrompt;
      
      // Handle different types of prompts
      if (!Array.isArray(prompt)) {
        messages = [{ role: 'user', content: prompt }];
      } else {
        messages = this.formatMessages(prompt as unknown as Message[], systemPrompt);
        
        // Extract system message if present in the messages array
        const systemMessage = (prompt as unknown as Message[]).find(m => m.role === MessageRole.SYSTEM);
        if (systemMessage && !system) {
          system = this.getTextFromContentBlocks(systemMessage.content);
        }
      }
      
      // Usage tracking
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let accumulatedContent = '';
      
      // Create streaming request
      const stream = await this.client.messages.create({
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens || 1024,
        stop_sequences: stopSequences,
        system,
        stream: true,
      });
      
      // Process streaming response
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta') {
          let textDelta = '';
          
          // Handle different types of content blocks
          if (chunk.delta && 'text' in chunk.delta) {
            textDelta = chunk.delta.text || '';
          } else if (chunk.delta) {
            // For other delta types, just convert to string
            textDelta = JSON.stringify(chunk.delta);
          }
          
          if (textDelta) {
            accumulatedContent += textDelta;
            
            // Send the delta to the stream
            onChunk({
              streamId,
              chunkId: `${streamId}-${Date.now()}`,
              type: 'content_delta',
              payload: { text: textDelta },
              timestamp: new Date(),
              isFinal: false,
              modelId: modelId,
              metadata: { provider: 'anthropic' }
            });
          }
        } else if (chunk.type === 'message_delta') {
          // Track usage if available in the chunk
          if (chunk.usage) {
            totalPromptTokens = chunk.usage.input_tokens || 0;
            totalCompletionTokens = chunk.usage.output_tokens || 0;
          }
        }
      }
      
      // If we didn't get usage info from the stream, estimate it
      if (totalPromptTokens === 0) {
        for (const message of messages) {
          const content = typeof message.content === 'string' ? message.content : '';
          totalPromptTokens += await this.countTokens(content);
        }
        if (system) {
          totalPromptTokens += await this.countTokens(system);
        }
      }
      
      if (totalCompletionTokens === 0) {
        totalCompletionTokens = await this.countTokens(accumulatedContent);
      }
      
      // Send final chunk
      onChunk({
        streamId,
        chunkId: `${streamId}-final-${Date.now()}`,
        type: 'content_delta',
        payload: { text: '' },  // Empty final delta
        timestamp: new Date(),
        isFinal: true,
        modelId: modelId,
        metadata: { 
          provider: 'anthropic',
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
            estimatedCost: this.calculateCost(modelId, totalPromptTokens, totalCompletionTokens)
          },
          stopReason: 'end_turn'
        }
      });
      
      // Return complete response
      return {
        modelId,
        provider: 'anthropic',
        content: accumulatedContent,
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          estimatedCost: this.calculateCost(modelId, totalPromptTokens, totalCompletionTokens),
        },
        metadata: {
          stopReason: 'end_turn',
        }
      };
    } catch (error) {
      logger.error('Anthropic Streaming Error:', error);
      
      // Send error chunk
      onChunk({
        streamId,
        chunkId: `${streamId}-error-${Date.now()}`,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
        timestamp: new Date(),
        isFinal: true,
        modelId: params.modelId,
        metadata: { provider: 'anthropic' }
      });
      
      throw new Error(`Anthropic Streaming Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Extract text from Anthropic API response content blocks
   */
  private extractTextFromContent(content: AnthropicContentBlock[]): string {
    // Extract text from content blocks and join with newlines
    return content
      .map(block => {
        if ('text' in block) {
          return block.text;
        }
        // Handle other block types if needed
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  
  formatMessages(messages: Message[], systemPrompt?: string): AnthropicMessageParam[] {
    // Convert Miktos message format to Anthropic format
    return messages
      .map(message => {
        // Extract text content from ContentBlock array
        const contentText = this.getTextFromContentBlocks(message.content);
        
        // Anthropic only accepts user and assistant roles in messages array
        if (message.role === MessageRole.USER || message.role === MessageRole.ASSISTANT) {
          return {
            role: message.role === MessageRole.USER ? 'user' : 'assistant',
            content: contentText,
          } as AnthropicMessageParam;
        }
        // Skip system messages as they're handled separately
        return null;
      })
      .filter(Boolean) as AnthropicMessageParam[];
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
  
  async countTokens(text: string): Promise<number> {
    try {
      // This is a simple approximation - in a real implementation,
      // you would use Anthropic's tokenizer
      return Math.ceil(text.length / 4.5);
    } catch (error) {
      logger.error('Token counting error:', error);
      // Return an approximation if tokenization fails
      return Math.ceil(text.length / 4.5);
    }
  }
  
  private calculateCost(modelId: string, promptTokens: number, completionTokens: number): number {
    // Cost estimates in USD per 1K tokens
    const costs: Record<string, { input: number, output: number }> = {
      [MODEL_IDS.CLAUDE_3_OPUS]: { input: 0.015, output: 0.075 },
      [MODEL_IDS.CLAUDE_3_SONNET]: { input: 0.003, output: 0.015 },
      [MODEL_IDS.CLAUDE_3_HAIKU]: { input: 0.00025, output: 0.00125 },
    };
    
    const modelCost = costs[modelId] || costs[MODEL_IDS.CLAUDE_3_HAIKU];
    
    const inputCost = (promptTokens / 1000) * modelCost.input;
    const outputCost = (completionTokens / 1000) * modelCost.output;
    
    return inputCost + outputCost;
  }
}
