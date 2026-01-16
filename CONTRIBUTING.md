# Contributing to Claude-B

Thank you for your interest in contributing to Claude-B! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (recommended) or npm
- [Claude Code](https://claude.ai/code) installed and configured

### Setup

```bash
# Clone the repository
git clone https://github.com/danimoya/Claude-B.git
cd Claude-B

# Install dependencies
pnpm install

# Build the project
pnpm build

# Link globally for testing
pnpm link --global
```

## Development Workflow

### Running in Development Mode

```bash
# Watch mode - rebuilds on changes
pnpm dev
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests once (no watch)
npx vitest run

# Run specific test file
npx vitest run src/session/session.test.ts
```

### Linting

```bash
# Run ESLint
pnpm lint

# Type check
pnpm typecheck
```

### Building

```bash
# Production build
pnpm build
```

## Project Structure

```
src/
├── cli/           # CLI entry point and commands
├── daemon/        # Background daemon and session management
├── session/       # Session class wrapping Claude Code
├── rest/          # REST API server and routes
├── hooks/         # Shell hooks and webhooks
├── orchestration/ # Multi-host orchestration
└── utils/         # Shared utilities
```

## Code Style

- TypeScript strict mode is enabled
- Use async/await over callbacks
- Use EventEmitter for streaming data
- Errors should be typed exceptions
- Tests go alongside source files (`*.test.ts`)

### Naming Conventions

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`

## Pull Request Process

1. **Fork & Branch**: Create a feature branch from `main`
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Develop**: Make your changes with clear, focused commits

3. **Test**: Ensure all tests pass
   ```bash
   pnpm test
   pnpm typecheck
   pnpm lint
   ```

4. **Document**: Update README.md if adding new features

5. **Submit**: Open a pull request with:
   - Clear description of changes
   - Link to any related issues
   - Screenshots/examples if applicable

## Testing Guidelines

- Write tests for new features
- Test files should be co-located: `feature.ts` → `feature.test.ts`
- Use descriptive test names
- Test both success and error cases

Example:

```typescript
describe('SessionManager', () => {
  describe('create', () => {
    it('should create a new session with name', async () => {
      const session = await manager.create('test-session');
      expect(session.name).toBe('test-session');
    });

    it('should throw for invalid input', async () => {
      await expect(manager.create('')).rejects.toThrow();
    });
  });
});
```

## Reporting Issues

When reporting bugs, please include:

- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or error messages

## Feature Requests

Feature requests are welcome! Please:

- Check existing issues first
- Describe the use case
- Explain why existing features don't solve it
- Propose a solution if you have one

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 license.

## Questions?

Feel free to open an issue for any questions about contributing.
