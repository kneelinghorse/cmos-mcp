/**
 * Model Transpilers Tests
 */

import { describe, test, expect } from '@jest/globals';
import {
  ModelTranspiler,
  isAlreadyFormatted,
  getModelConfig,
} from '../../src/intelligence/model-transpilers';

describe('ModelTranspiler', () => {
  let transpiler: ModelTranspiler;

  beforeEach(() => {
    transpiler = new ModelTranspiler();
  });

  describe('Claude transpilation', () => {
    test('should wrap sections in XML tags', () => {
      const content = `objective: Create a test mission
context: This is test context
successCriteria: Must pass all tests`;

      const result = transpiler.transpile(content, 'claude');

      expect(result).toContain('<instructions>');
      expect(result).toContain('</instructions>');
      expect(result).toContain('<context>');
      expect(result).toContain('</context>');
    });

    test('should handle content already with XML tags', () => {
      const content = '<instructions>Test objective</instructions>';
      const result = transpiler.transpile(content, 'claude');

      expect(result).toContain('<instructions>');
    });

    test('should convert markdown headers to XML', () => {
      const content = '# Section Header\nContent here';
      const result = transpiler.transpile(content, 'claude');

      expect(result).toContain('<section_header>');
    });
  });

  describe('GPT transpilation', () => {
    test('should add ### delimiters', () => {
      const content = `objective: Create a test mission
context: This is test context`;

      const result = transpiler.transpile(content, 'gpt');

      expect(result).toContain('### OBJECTIVE');
      expect(result).toContain('### CONTEXT');
    });

    test('should structure examples for few-shot learning', () => {
      const content = `objective: Test
example: Input: test
Output: result`;

      const result = transpiler.transpile(content, 'gpt');

      expect(result).toContain('### EXAMPLE');
      expect(result).toContain('```');
    });
  });

  describe('Gemini transpilation', () => {
    test('should convert to PTCF framework', () => {
      const content = `objective: Create a test mission
context: This is test context
deliverables: Test output`;

      const result = transpiler.transpile(content, 'gemini');

      expect(result).toContain('Persona:');
      expect(result).toContain('Task:');
      expect(result).toContain('Context:');
      expect(result).toContain('Format:');
    });

    test('should extract objective as task', () => {
      const content = 'objective: Build a feature';
      const result = transpiler.transpile(content, 'gemini');

      expect(result).toContain('Task: Build a feature');
    });

    test('should extract context section', () => {
      const content = 'context: Important background information';
      const result = transpiler.transpile(content, 'gemini');

      expect(result).toContain('Context: Important background information');
    });
  });

  describe('isAlreadyFormatted', () => {
    test('should detect Claude XML format', () => {
      const content = '<instructions>Test</instructions>';
      expect(isAlreadyFormatted(content, 'claude')).toBe(true);
    });

    test('should detect GPT markdown format', () => {
      const content = '### OBJECTIVE\nTest content';
      expect(isAlreadyFormatted(content, 'gpt')).toBe(true);
    });

    test('should detect Gemini PTCF format', () => {
      const content = 'Persona: AI\nTask: Test\nContext: None\nFormat: JSON';
      expect(isAlreadyFormatted(content, 'gemini')).toBe(true);
    });

    test('should return false for unformatted content', () => {
      const content = 'Just plain text';
      expect(isAlreadyFormatted(content, 'claude')).toBe(false);
      expect(isAlreadyFormatted(content, 'gpt')).toBe(false);
      expect(isAlreadyFormatted(content, 'gemini')).toBe(false);
    });
  });

  describe('getModelConfig', () => {
    test('should return Claude config', () => {
      const config = getModelConfig('claude');
      expect(config.model).toBe('claude');
      expect(config.templateFormat).toBe('xml');
      expect(config.supportsXmlTags).toBe(true);
    });

    test('should return GPT config', () => {
      const config = getModelConfig('gpt');
      expect(config.model).toBe('gpt');
      expect(config.templateFormat).toBe('markdown');
      expect(config.supportsFewShot).toBe(true);
    });

    test('should return Gemini config', () => {
      const config = getModelConfig('gemini');
      expect(config.model).toBe('gemini');
      expect(config.templateFormat).toBe('ptcf');
    });
  });

  describe('Edge cases', () => {
    test('should handle empty content', () => {
      const result = transpiler.transpile('', 'claude');
      expect(result).toBeDefined();
    });

    test('should handle content with no recognized sections', () => {
      const content = 'Random text without any sections';
      const result = transpiler.transpile(content, 'claude');
      expect(result).toBeDefined();
    });

    test('should preserve content integrity', () => {
      const content = 'objective: Test mission';
      const claudeResult = transpiler.transpile(content, 'claude');
      const gptResult = transpiler.transpile(content, 'gpt');
      const geminiResult = transpiler.transpile(content, 'gemini');

      // All should contain the original objective text
      expect(claudeResult).toContain('Test mission');
      expect(gptResult).toContain('Test mission');
      expect(geminiResult).toContain('Test mission');
    });
  });
});
