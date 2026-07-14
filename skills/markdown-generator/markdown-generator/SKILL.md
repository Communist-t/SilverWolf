---
name: markdown_generator
description: "Use this skill whenever the user wants to generate, format, or structure a Markdown document (.md). This is especially useful for creating standard reports, readmes, or technical documentation that needs to follow a specific organizational structure."
---

# Markdown Document Generation

## Overview
This skill provides instructions on how to generate consistently formatted Markdown documents. 

## Formatting Requirements

### 1. Mandatory Standard Template
To ensure all generated documents look professional and consistent, you **MUST** use the standard organizational template. 

**CRITICAL INSTRUCTION:** 
Before writing the document, you must read the standard template. The template is located at:
`references/template.md`
Please use your available tools to read this file.

### 2. Document Construction
Once you have loaded the template:
1. Read the placeholders in the template (e.g., `[Title]`, `[Author]`, `[Date]`, `[Content]`).
2. Replace these placeholders with the actual content generated for the user's request.
3. Save the final output as a `.md` file in the current working directory, or return the raw markdown if saving is not requested.

### 3. Style Guidelines
- Use clear, hierarchical headings (H1, H2, H3).
- Use bulleted or numbered lists for readability.
- If writing code, always use fenced code blocks with the correct language identifier.