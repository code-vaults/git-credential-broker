import config from '@1stg/nano-staged'

const { '*.{gql,graphql,html,jsonc,json5,md,mdx,toml,yaml,yml}': _mdAndOthers, ...rest } = config

export default {
  ...rest,
  '*.{gql,graphql,html,jsonc,json5,toml,yaml,yml}': [
    'eslint --fix',
    'oxfmt --no-error-on-unmatched-pattern --ignore-path .gitignore --ignore-path .oxfmtignore',
  ],
  '*.{md,mdx}': ['eslint --fix', 'prettier --write'],
}
