# Contributing to Lifespan

Thanks for helping. Lifespan aims to stay small, dependency-free and easy to self-host, so please keep changes in that spirit.

## Development

Requires Node.js 22.13 or newer. There is nothing to install.

```bash
npm run dev          # restarts on file changes
npm test             # unit and API tests
npm run acceptance   # end-to-end run against a real server process
```

## Ground rules

- **No runtime dependencies.** The server uses only Node built-ins; the web app has no framework or build step.
- **Tests with every change.** New endpoints need API tests in `test/`, and user journeys belong in `scripts/acceptance.js`.
- **Keep the API stable.** Prices are integer cents and dates are `YYYY-MM-DD` everywhere.
- **Accessibility and both themes.** Check light mode, dark mode and a phone-width viewport before opening a pull request.
- **Security first.** Anything that serves user files or accepts input must be validated and covered by a test.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change with tests.
3. Make sure `npm test` and `npm run acceptance` pass.
4. Describe what changed and why in the pull request.

By contributing you agree that your contributions are licensed under the MIT License.
