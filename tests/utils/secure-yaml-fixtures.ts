import { SecureYAMLLoader } from '../../src/loaders/yaml-loader';
import { JSONSchema } from '../../src/types/schemas';

/**
 * Shared types for SecureYAMLLoader fixtures used across test suites.
 * Keeping these definitions in one place ensures we always load fixtures
 * with explicit typing instead of falling back to `unknown`.
 */
export interface SimpleYamlFixture {
  name: string;
  version: number;
  enabled: boolean;
}

export interface NestedYamlFixture {
  server: {
    host: string;
    port: number;
    ssl: {
      enabled: boolean;
      cert: string;
    };
  };
}

export interface ItemsYamlFixture {
  items: Array<{
    name: string;
    value: number;
  }>;
}

export interface AnchoredEnvYamlFixture {
  defaults: {
    timeout: number;
    retries: number;
  };
  production: {
    timeout: number;
    retries: number;
    host: string;
  };
  staging: {
    timeout: number;
    retries: number;
    host: string;
  };
}

export interface MultilineYamlFixture {
  description: string;
}

export interface NullHandlingYamlFixture {
  nullValue: null;
  emptyValue: null;
  undefinedValue: null;
}

export interface AppConfigFixture {
  name: string;
  version: string;
}

export interface ServerConfigFixture {
  server: {
    host: string;
    port: number;
  };
}

export interface UsersYamlFixture {
  users: Array<{
    id: number;
    name: string;
  }>;
}

export interface EnumYamlFixture {
  status: 'active' | 'inactive' | 'pending';
}

export interface ValueEntryFixture {
  value: number;
}

export interface NamedConfigFixture {
  name: string;
  version: number;
}

/**
 * Load a YAML test fixture with explicit typing.
 */
export async function loadYamlFixture<T>(
  loader: SecureYAMLLoader,
  filename: string,
  schema?: JSONSchema
): Promise<T> {
  const result = await loader.load<T>(filename, schema);
  return result;
}

/**
 * Load multiple YAML fixtures with explicit typing.
 */
export async function loadYamlFixtures<T>(
  loader: SecureYAMLLoader,
  filenames: string[],
  schema?: JSONSchema
): Promise<T[]> {
  const result = await loader.loadMultiple(filenames, schema);
  return result as T[];
}
