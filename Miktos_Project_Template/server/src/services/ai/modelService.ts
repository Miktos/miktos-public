// AI Model Service Factory
import { OpenAIProvider } from './openaiProvider';
import { AnthropicProvider } from './anthropicProvider';
import { GoogleAIProvider } from './googleaiProvider';
import { ModelProvider } from './baseProvider';
import { PROVIDERS } from 'miktos-shared/constants';
import { AppConfig } from '../../config'; // Import AppConfig

export class ModelService {
  private providers: Map<string, ModelProvider>;
  
  constructor(private config: AppConfig) { // Inject AppConfig
    this.providers = new Map();
    this.initializeProviders();
  }
  
  private initializeProviders(): void {
    try {
      // Initialize OpenAI provider if API key is available
      if (this.config.openaiApiKey) {
        this.providers.set(PROVIDERS.OPENAI, new OpenAIProvider(this.config.openaiApiKey));
        console.log('OpenAI provider initialized');
      } else {
        console.warn('OpenAI API key not found in config, provider not initialized');
      }
      
      // Initialize Anthropic provider if API key is available
      if (this.config.anthropicApiKey) {
        this.providers.set(PROVIDERS.ANTHROPIC, new AnthropicProvider(this.config.anthropicApiKey));
        console.log('Anthropic provider initialized');
      } else {
        console.warn('Anthropic API key not found in config, provider not initialized');
      }
      
      // Initialize Google AI provider if API key is available
      // Assuming your config calls it geminiApiKey based on the .env structure
      if (this.config.geminiApiKey) { 
        this.providers.set(PROVIDERS.GOOGLE, new GoogleAIProvider(this.config.geminiApiKey));
        console.log('Google AI provider initialized');
      } else {
        console.warn('Google API key (GEMINI_API_KEY) not found in config, provider not initialized');
      }
    } catch (error) {
      console.error('Error initializing AI providers:', error);
    }
  }
  
  getProviderForModel(modelId: string): ModelProvider | null {
    // Determine provider from model ID
    let provider: string;
    if (modelId.startsWith('gpt')) {
      provider = PROVIDERS.OPENAI;
    } else if (modelId.startsWith('claude')) {
      provider = PROVIDERS.ANTHROPIC;
    } else if (modelId.startsWith('gemini')) {
      provider = PROVIDERS.GOOGLE;
    } else {
      console.warn(`Unknown model ID format: ${modelId}`);
      return null;
    }
    
    // Return the appropriate provider
    const modelProvider = this.providers.get(provider);
    if (!modelProvider) {
      console.warn(`Provider ${provider} not initialized`);
      return null;
    }
    
    return modelProvider;
  }
  
  async isProviderAvailable(provider: string): Promise<boolean> {
    const modelProvider = this.providers.get(provider);
    if (!modelProvider) {
      return false;
    }
    
    return await modelProvider.isAvailable();
  }
  
  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}
