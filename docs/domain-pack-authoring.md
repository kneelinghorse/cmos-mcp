# Domain Pack Authoring Guide

This guide explains how to create production-ready domain packs for the Mission Protocol v2 system.

## What is a Domain Pack?

A domain pack extends the generic mission template with domain-specific fields. It consists of three files:

1. **pack.yaml** - Metadata and manifest
2. **schema.json** - JSON Schema for domain fields validation
3. **template.yaml** - Default values for domain fields

## Directory Structure

```
app/templates/domains/
├── your-domain/
│   ├── pack.yaml          # Manifest
│   ├── schema.json        # JSON Schema
│   └── template.yaml      # Default template
```

## Creating a Domain Pack

### Step 1: Create Directory

```bash
mkdir -p app/templates/domains/your-domain
```

### Step 2: Create pack.yaml

The manifest defines metadata about your domain pack:

```yaml
name: 'category.domain-name'
version: '1.0.0'
displayName: 'Human-Readable Name'
description: "Brief description of the domain pack's purpose"
author: 'core-team'
schema: 'schema.json'
```

**Field Requirements:**

- `name`: Unique identifier (use dot notation for categorization)
- `version`: SemVer format (e.g., "1.0.0")
- `displayName`: User-friendly name shown in tools
- `description`: Clear, concise purpose statement
- `author`: Author or team name
- `schema`: Reference to schema file (usually "schema.json")

### Step 3: Create schema.json

Define the structure and validation rules for your domain-specific fields:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "yourField": {
      "type": "string",
      "description": "Description of this field"
    },
    "yourArray": {
      "type": "array",
      "description": "Description of this array",
      "items": {
        "type": "string"
      }
    },
    "yourObject": {
      "type": "object",
      "description": "Complex nested structure",
      "properties": {
        "nestedField": {
          "type": "string"
        }
      },
      "required": ["nestedField"]
    }
  },
  "required": ["yourField"],
  "additionalProperties": false
}
```

**Best Practices:**

- Use JSON Schema Draft 7 format
- Include descriptions for all fields
- Mark required fields explicitly
- Set `additionalProperties: false` to prevent unexpected fields
- Use appropriate types: string, number, boolean, array, object
- Validate complex structures with nested schemas

### Step 4: Create template.yaml

Provide default values matching your schema:

```yaml
yourField: ''
yourArray: []
yourObject:
  nestedField: ''
```

**Requirements:**

- All schema properties must have defaults
- Use empty strings for required string fields
- Use empty arrays for array fields
- Provide nested structures for object fields

## Example: Software Development Pack

Here's a complete example of a production-ready domain pack:

### pack.yaml

```yaml
name: 'software.technical-task'
version: '1.0.0'
displayName: 'Software Development Task'
description: 'Missions for designing and implementing software features'
author: 'core-team'
schema: 'schema.json'
```

### schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "userStory": {
      "type": "string",
      "description": "User story describing the feature from end-user perspective"
    },
    "technicalApproach": {
      "type": "array",
      "description": "Step-by-step technical implementation approach",
      "items": {
        "type": "string"
      }
    },
    "nonFunctionalRequirements": {
      "type": "array",
      "description": "Performance, security, and other non-functional requirements",
      "items": {
        "type": "object",
        "properties": {
          "description": {
            "type": "string",
            "description": "Description of the non-functional requirement"
          },
          "metric": {
            "type": "string",
            "description": "Measurable metric for validation"
          }
        },
        "required": ["description", "metric"]
      }
    },
    "outOfScope": {
      "type": "array",
      "description": "Features or aspects explicitly excluded from this mission",
      "items": {
        "type": "string"
      }
    }
  },
  "required": ["userStory", "technicalApproach"],
  "additionalProperties": false
}
```

### template.yaml

```yaml
userStory: ''
technicalApproach: []
nonFunctionalRequirements: []
outOfScope: []
```

## Registering Your Domain Pack

After creating your domain pack, register it in `app/templates/registry.yaml`:

```yaml
domains:
  # ... existing domains ...

  - name: category.domain-name
    description: Brief description
    version: 1.0.0
    author: your-name
    path: domains/your-domain
    schema_version: 1.0.0
```

## Testing Your Domain Pack

### 1. Unit Tests

Verify your pack loads correctly:

```typescript
import { DomainPackLoader } from '../src/domains/domain-pack-loader';
import { RegistryParser } from '../src/registry/registry-parser';

const pack = packLoader.loadPack('your.domain-name', entries);
expect(pack.manifest.name).toBe('your.domain-name');
expect(pack.schema).toBeDefined();
expect(pack.template).toBeDefined();
```

### 2. Integration Tests

Test mission creation with your domain:

```typescript
const result = createMissionTool.execute(
  {
    objective: 'Test your domain',
    domain: 'your.domain-name',
  },
  entries
);

const mission = YAML.parse(result);
expect(mission.domainFields.yourField).toBeDefined();
```

### 3. Manual Testing

```bash
# Run tests
cd app && npm test

# Test with MCP server
cd app && npm run build && npm start
```

## Validation Checklist

Before considering your domain pack production-ready:

- [ ] pack.yaml has all required fields
- [ ] name follows dot notation convention
- [ ] version uses SemVer format
- [ ] schema.json is valid JSON Schema Draft 7
- [ ] All schema properties have descriptions
- [ ] Required fields are marked in schema
- [ ] template.yaml matches schema structure
- [ ] All required fields have default values
- [ ] Pack is registered in registry.yaml
- [ ] Unit tests pass for pack loading
- [ ] Integration tests pass for mission creation
- [ ] Documentation explains domain-specific fields

## Common Patterns

### Arrays of Strings

```json
{
  "items": {
    "type": "array",
    "items": { "type": "string" }
  }
}
```

### Arrays of Objects

```json
{
  "steps": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "duration": { "type": "number" }
      },
      "required": ["name"]
    }
  }
}
```

### Optional Fields

```json
{
  "properties": {
    "optional": { "type": "string" }
  },
  "required": []
}
```

### Enum Values

```json
{
  "priority": {
    "type": "string",
    "enum": ["low", "medium", "high"],
    "description": "Task priority level"
  }
}
```

## Best Practices

1. **Keep It Focused**: Each domain pack should serve a specific purpose
2. **Use Clear Names**: Field names should be self-explanatory
3. **Provide Descriptions**: Every field needs a description
4. **Validate Thoroughly**: Use required fields and type constraints
5. **Test Extensively**: Write integration tests for your pack
6. **Document Examples**: Show real-world usage examples
7. **Version Properly**: Follow SemVer for versioning
8. **Maintain Compatibility**: Avoid breaking changes in minor versions

## Domain Pack Examples

Mission Protocol v2 includes these production-ready domain packs:

- **software.technical-task**: Software development features
- **business.market-research**: Business analysis and research

Study these examples when creating your own domain packs.

## Troubleshooting

### Pack Not Found

- Verify pack is registered in registry.yaml
- Check path in registry matches directory name
- Ensure pack.yaml exists in the directory

### Schema Validation Errors

- Validate schema at https://www.jsonschemavalidator.net/
- Ensure all required fields are in template
- Check for typos in field names

### Template Merge Errors

- Verify template.yaml structure matches schema
- Check for YAML syntax errors
- Ensure all arrays and objects are initialized

## Advanced Topics

### Custom Merge Strategies

Domain fields are merged using the default `concat` strategy. Future versions may support custom merge strategies.

### Schema References

You can use JSON Schema `$ref` to reuse definitions:

```json
{
  "definitions": {
    "person": {
      "type": "object",
      "properties": {
        "name": { "type": "string" }
      }
    }
  },
  "properties": {
    "author": { "$ref": "#/definitions/person" }
  }
}
```

### Multi-File Schemas

For complex domains, you can split schemas into multiple files and reference them.

## Support

For questions or issues:

1. Check existing domain packs for examples
2. Review integration tests in `app/tests/integration/`
3. Consult the Mission Protocol documentation

---

**Version**: 1.0.0
**Last Updated**: 2025-10-04
**Maintainer**: Mission Protocol Team
