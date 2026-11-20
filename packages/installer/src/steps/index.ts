import { bootstrap } from './bootstrap';
import { build } from './build';
import { deploy } from './deploy';
import { dns } from './dns';
import { health } from './health';
import { keys } from './keys';
import { login } from './login';
import { mail } from './mail';
import { migrations } from './migrations';
import { postDeploy } from './postdeploy';
import { preflight } from './preflight';
import { prompts } from './prompts';
import { render } from './render';
import { resources } from './resources';
import { signin } from './signin';
import type { Step } from './step';
import { summary } from './summary';
import { turnstile } from './turnstile';

export const INSTALL_STEPS: readonly Step[] = [
  preflight,
  login,
  prompts,
  resources,
  keys,
  turnstile,
  mail,
  dns,
  render,
  migrations,
  build,
  deploy,
  postDeploy,
  bootstrap,
  signin,
  health,
  summary,
];

export { runSteps } from './step';
