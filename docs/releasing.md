# Release packages

Run from repository root.

1. Update package version:

   ```bash
   npm version patch --workspace packages/pi-auto-compact
   ```

2. Run checks:

   ```bash
   npm test
   npm run typecheck
   npm run pack:check
   npm run test:live
   ```

3. Publish package:

   ```bash
   npm publish --workspace @henryqw/pi-auto-compact --access public
   ```

4. Push commit and tag created by `npm version`:

   ```bash
   git push --follow-tags origin main
   ```

Do not publish without a version change. Keep package scope `@henryqw` for every future Pi package.
