/**
 * Model Transpilers
 *
 * Model-specific formatting and transpilation following R4.1 findings:
 * - Claude: XML tags for structure
 * - GPT: ### delimiters and few-shot examples
 * - Gemini: PTCF framework (Persona, Task, Context, Format)
 */

import { IModelTranspiler, SupportedModel, ModelConfig } from './types';

/**
 * Model configurations
 */
const modelConfigs: Record<SupportedModel, ModelConfig> = {
  claude: {
    model: 'claude',
    templateFormat: 'xml',
    supportsXmlTags: true,
    preferredDelimiters: ['<instructions>', '<context>', '<example>'],
  },
  gpt: {
    model: 'gpt',
    templateFormat: 'markdown',
    supportsFewShot: true,
    preferredDelimiters: ['###', '"""'],
  },
  gemini: {
    model: 'gemini',
    templateFormat: 'ptcf',
    preferredDelimiters: ['Persona:', 'Task:', 'Context:', 'Format:'],
  },
};

/**
 * Model transpiler implementation
 */
export class ModelTranspiler implements IModelTranspiler {
  /**
   * Transpile content to target model's preferred format
   */
  transpile(content: string, targetModel: SupportedModel): string {
    switch (targetModel) {
      case 'claude':
        return this.transpileToClaude(content);
      case 'gpt':
        return this.transpileToGPT(content);
      case 'gemini':
        return this.transpileToGemini(content);
      default:
        return content;
    }
  }

  /**
   * Transpile to Claude format (XML tags)
   */
  private transpileToClaude(content: string): string {
    let result = content;

    // Wrap sections in XML tags
    result = this.wrapSection(result, 'objective', 'instructions');
    result = this.wrapSection(result, 'context', 'context');
    result = this.wrapSection(result, 'successCriteria', 'success_criteria');
    result = this.wrapSection(result, 'deliverables', 'deliverables');

    // Convert markdown headers to XML sections
    result = result.replace(/^#{1,3}\s+(.+)$/gm, (match, header) => {
      const tag = header.toLowerCase().replace(/\s+/g, '_');
      return `<${tag}>`;
    });

    return result;
  }

  /**
   * Transpile to GPT format (### delimiters and clear structure)
   */
  private transpileToGPT(content: string): string {
    let result = content;

    // Add clear delimiters for major sections
    result = this.addDelimiters(result, 'objective', '### OBJECTIVE');
    result = this.addDelimiters(result, 'context', '### CONTEXT');
    result = this.addDelimiters(result, 'successCriteria', '### SUCCESS CRITERIA');
    result = this.addDelimiters(result, 'deliverables', '### DELIVERABLES');

    // Structure examples for few-shot learning if present
    result = this.structureExamples(result);

    return result;
  }

  /**
   * Transpile to Gemini format (PTCF framework)
   */
  private transpileToGemini(content: string): string {
    const ptcf = this.extractPTCF(content);

    return `Persona: ${ptcf.persona}

Task: ${ptcf.task}

Context: ${ptcf.context}

Format: ${ptcf.format}`;
  }

  /**
   * Wrap a section in XML tags
   */
  private wrapSection(content: string, sectionName: string, tagName: string): string {
    const sectionRegex = new RegExp(`${sectionName}:([\\s\\S]*?)(?=\\n\\w+:|$)`, 'i');
    return content.replace(sectionRegex, (match, sectionContent) => {
      return `<${tagName}>${sectionContent.trim()}</${tagName}>`;
    });
  }

  /**
   * Add delimiters before sections
   */
  private addDelimiters(content: string, sectionName: string, delimiter: string): string {
    const sectionRegex = new RegExp(`${sectionName}:`, 'i');
    return content.replace(sectionRegex, `${delimiter}\n`);
  }

  /**
   * Structure examples for few-shot learning
   */
  private structureExamples(content: string): string {
    // Look for example patterns
    const exampleRegex = /example:?\s*([^]*?)(?=\n\n|$)/gi;
    let exampleCount = 0;

    return content.replace(exampleRegex, (match, exampleContent) => {
      exampleCount++;
      return `### EXAMPLE ${exampleCount}\n\`\`\`\n${exampleContent.trim()}\n\`\`\``;
    });
  }

  /**
   * Extract PTCF components from content
   */
  private extractPTCF(content: string): {
    persona: string;
    task: string;
    context: string;
    format: string;
  } {
    // Default PTCF structure
    const ptcf = {
      persona: 'You are an AI assistant specializing in mission execution.',
      task: '',
      context: '',
      format: 'Provide clear, structured output.',
    };

    // Extract objective as task
    const objectiveMatch = content.match(/objective:?\s*([^]*?)(?=\n\w+:|$)/i);
    if (objectiveMatch) {
      ptcf.task = objectiveMatch[1].trim();
    }

    // Extract context
    const contextMatch = content.match(/context:?\s*([^]*?)(?=\n\w+:|$)/i);
    if (contextMatch) {
      ptcf.context = contextMatch[1].trim();
    }

    // Extract deliverables as format guidance
    const deliverablesMatch = content.match(/deliverables:?\s*([^]*?)(?=\n\w+:|$)/i);
    if (deliverablesMatch) {
      ptcf.format = `Deliver: ${deliverablesMatch[1].trim()}`;
    }

    return ptcf;
  }
}

/**
 * Export singleton instance
 */
export const defaultTranspiler = new ModelTranspiler();

/**
 * Get model configuration
 */
export function getModelConfig(model: SupportedModel): ModelConfig {
  return modelConfigs[model];
}

/**
 * Check if content is already formatted for target model
 */
export function isAlreadyFormatted(content: string, targetModel: SupportedModel): boolean {
  switch (targetModel) {
    case 'claude':
      // Check for XML tags
      return /<\w+>.*<\/\w+>/s.test(content);

    case 'gpt':
      // Check for ### delimiters
      return /###\s+\w+/.test(content);

    case 'gemini':
      // Check for PTCF structure
      return /Persona:.*Task:.*Context:.*Format:/s.test(content);

    default:
      return false;
  }
}
