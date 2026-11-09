import { defineConfig } from '@1stg/eslint-config'

export default defineConfig({
  ignores: ['docker-compose.example.yml'],
  configs: [
    {
      files: ['.github/workflows/*.yml'],
      rules: { 'yml/no-empty-mapping-value': 'off' },
    },
  ],
})
