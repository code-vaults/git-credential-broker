import { defineConfig } from '@1stg/oxlint-config'

export default defineConfig({
  // The existing tree uses explicit numeric modes and sequential await loops; keep those
  // deliberate choices rather than rewriting the broker for style.
  noMagicNumbers: false,
  rules: {
    'no-await-in-loop': 'off',
    'no-empty-function': 'off',
    'no-shadow': 'off',
    'no-useless-assignment': 'off',
  },
})
