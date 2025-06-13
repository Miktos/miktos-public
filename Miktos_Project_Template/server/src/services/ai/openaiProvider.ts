// OpenAI implementation of the model provider interface
import OpenAI from 'openai';
import type { 
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam
} from 'openai/resources/chat/completions';
import { BaseModelProvider } from './baseProvider';
import {
  AIModelRequest,
  AIModelResponse,
  Message,
  MessageRole,
  ContentBlock,
  ContentBlockType,
  StreamChunk,
} from 'miktos-shared/types';
import { MODEL_IDS } from 'miktos-shared/constants';
import { logger } from '../../utils/logger';

export class OpenAIProvider extends BaseModelProvider {
  private client: InstanceType<typeof OpenAI>;

  constructor(apiKey: string) {
    super(apiKey);
    this.client = new OpenAI({ apiKey });
  }

  async generate(params: AIModelRequest): Promise<AIModelResponse> {
    try {
      const { modelId, temperature = 0.7, maxTokens, stopSequences, systemPrompt, prompt } = params;

      // For a simple text completion without a chat history
      if (!Array.isArray(prompt)) {
        const messages: ChatCompletionMessageParam[] = [];

        if (systemPrompt) {
          messages.push({
            role: 'system',
            content: systemPrompt,
          });
        }

        messages.push({
          role: 'user',
          content: prompt,
        });

        const response = await this.client.chat.completions.create({
          model: modelId,
          messages,
          temperature,
          max_tokens: maxTokens,
          stop: stopSequences,
        });

        const content = response.choices[0]?.message?.content || '';

        return {
          modelId,
          provider: 'openai',
          content,
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
            estimatedCost: this.calculateCost(
              modelId,
              response.usage?.prompt_tokens || 0,
              response.usage?.completion_tokens || 0,
            ),
          },
          metadata: {
            finishReason: response.choices[0]?.finish_reason,
          },
        };
      } else {
        // Handle case where prompt is an array of messages
        const formattedMessages = this.formatMessages(prompt as unknown as Message[], systemPrompt);

        const response = await this.client.chat.completions.create({
          model: modelId,
          messages: formattedMessages,
          temperature,
          max_tokens: maxTokens,
          stop: stopSequences,
        });

        const content = response.choices[0]?.message?.content || '';

        return {
          modelId,
          provider: 'openai',
          content,
          usage: {
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            totalTokens: response.usage?.total_tokens || 0,
            estimatedCost: this.calculateCost(
              modelId,
              response.usage?.prompt_tokens || 0,
              response.usage?.completion_tokens || 0,
            ),
          },
          metadata: {
            finishReason: response.choices[0]?.finish_reason,
          },
        };
      }
    } catch (error) {
      logger.error('OpenAI API Error:', error);
      throw new Error(
        `OpenAI API Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async generateStream(
    params: AIModelRequest,
    streamId: string,
    onChunk: (chunk: StreamChunk) => void,
  ): Promise<AIModelResponse> {
    try {
      const { modelId, temperature = 0.7, maxTokens, stopSequences, systemPrompt, prompt } = params;

      let messages: ChatCompletionMessageParam[];

      // Handle different types of prompts
      if (!Array.isArray(prompt)) {
        messages = [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          { role: 'user' as const, content: prompt },
        ];
      } else {
        messages = this.formatMessages(prompt as unknown as Message[], systemPrompt);
      }

      // Usage tracking
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let accumulatedContent = '';

      // Create streaming request
      const stream = await this.client.chat.completions.create({
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
        stop: stopSequences,
        stream: true,
      });

      // Process streaming response
      for await (const chunk of stream) {
        const contentDelta = chunk.choices[0]?.delta?.content || '';

        if (contentDelta) {
          accumulatedContent += contentDelta;

          // Send the delta to the stream
          onChunk({
            streamId,
            chunkId: `${streamId}-${Date.now()}`,
            type: 'content_delta',
            payload: { text: contentDelta },
            timestamp: new Date(),
            isFinal: false,
            modelId: modelId,
            metadata: { provider: 'openai' },
          });
        }

        // Track usage if available in the chunk
        if (chunk.usage) {
          totalPromptTokens = chunk.usage.prompt_tokens;
          totalCompletionTokens = chunk.usage.completion_tokens;
        }
      }

      // If we didn't get usage info from the stream, estimate it
      if (totalPromptTokens === 0) {
        for (const message of messages) {
          const content = typeof message.content === 'string' ? message.content : '';
          totalPromptTokens += await this.countTokens(content);
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
        payload: { text: '' }, // Empty final delta
        timestamp: new Date(),
        isFinal: true,
        modelId: modelId,
        metadata: {
          provider: 'openai',
          usage: {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
            estimatedCost: this.calculateCost(modelId, totalPromptTokens, totalCompletionTokens),
          },
          finishReason: 'stop',
        },
      });

      // Return complete response
      return {
        modelId,
        provider: 'openai',
        content: accumulatedContent,
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          estimatedCost: this.calculateCost(modelId, totalPromptTokens, totalCompletionTokens),
        },
        metadata: {
          finishReason: 'stop',
        },
      };
    } catch (error) {
      logger.error('OpenAI Streaming Error:', error);

      // Send error chunk
      onChunk({
        streamId,
        chunkId: `${streamId}-error-${Date.now()}`,
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
        timestamp: new Date(),
        isFinal: true,
        modelId: params.modelId,
        metadata: { provider: 'openai' },
      });

      throw new Error(
        `OpenAI Streaming Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  formatMessages(messages: Message[], systemPrompt?: string): ChatCompletionMessageParam[] {
    const formattedMessages: ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (systemPrompt) {
      formattedMessages.push({
        role: 'system',
        content: systemPrompt,
      } as ChatCompletionSystemMessageParam);
    }

    // Convert Miktos message format to OpenAI format
    for (const message of messages) {
      // Extract text content from ContentBlock array
      const contentText = this.getTextFromContentBlocks(message.content);

      // OpenAI only allows certain roles
      if (message.role === MessageRole.SYSTEM) {
        formattedMessages.push({
          role: 'system',
          content: contentText,
        } as ChatCompletionSystemMessageParam);
      } else if (message.role === MessageRole.USER) {
        formattedMessages.push({
          role: 'user',
          content: contentText,
        } as ChatCompletionUserMessageParam);
      } else if (message.role === MessageRole.ASSISTANT) {
        formattedMessages.push({
          role: 'assistant',
          content: contentText,
        } as ChatCompletionAssistantMessageParam);
      } else if (message.role === MessageRole.TOOL) {
        // Ensure tool_call_id is provided for tool role
        formattedMessages.push({
          role: 'tool',
          content: contentText,
          tool_call_id: message.toolCallId || 'placeholder-tool-call-id',
        } as ChatCompletionToolMessageParam);
      }
    }

    return formattedMessages;
  }

  async countTokens(text: string): Promise<number> {
    try {
      // This is a simple approximation - in a real implementation,
      // you would use a proper tokenizer like tiktoken
      return Math.ceil(text.length / 4);
    } catch (error) {
      logger.error('Token counting error:', error);
      // Return an approximation if tokenization fails
      return Math.ceil(text.length / 4);
    }
  }

  private calculateCost(modelId: string, promptTokens: number, completionTokens: number): number {
    // Cost estimates in USD per 1K tokens
    const costs: Record<string, { input: number; output: number }> = {
      [MODEL_IDS.GPT_4]: { input: 0.03, output: 0.06 },
      [MODEL_IDS.GPT_4_TURBO]: { input: 0.01, output: 0.03 },
      [MODEL_IDS.GPT_3_5_TURBO]: { input: 0.0015, output: 0.002 },
    };

    const modelCost = costs[modelId] || costs[MODEL_IDS.GPT_3_5_TURBO];

    const inputCost = (promptTokens / 1000) * modelCost.input;
    const outputCost = (completionTokens / 1000) * modelCost.output;

    return inputCost + outputCost;
  }

  /**
   * Extracts text content from ContentBlock array
   * @param blocks Array of ContentBlock objects
   * @returns Text content joined as a single string
   */
  private getTextFromContentBlocks(blocks: any[]): string {
    if (Array.isArray(blocks)) {
      return blocks
        .map((block) => {
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
        })
        .join('\n');
    } else if (typeof blocks === 'string') {
      // Fallback for legacy handling - if somehow content is already a string
      return blocks;
    }
    return '';
  }
}
