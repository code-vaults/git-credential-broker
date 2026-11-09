import config from '@1stg/simple-git-hooks'

export default {
  ...config,
  'pre-push': 'yarn typecheck',
}
