import { hashOperatorPassword, MIN_OPERATOR_PASSWORD_LENGTH } from '../src/lib/passwordHash.js';

/**
 * Generates the scrypt hash for OPERATOR_PASSWORD_HASH.
 *
 *   npm run hash-operator-password -- "correct horse battery staple"
 *   npm run hash-operator-password            # prompts without echoing, keeping it off shell history
 */

const MIN = MIN_OPERATOR_PASSWORD_LENGTH;

const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const DELETE = 127;

function readHidden(): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('stdin is not a TTY — pass the password as an argument instead'));
  }
  return new Promise((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.codePointAt(0) ?? 0;
        if (code === CTRL_C || code === CTRL_D) {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (code === BACKSPACE || code === DELETE) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  let password = process.argv.slice(2).join(' ').trim();

  if (!password) {
    process.stdout.write(`Operator password (min ${MIN} characters): `);
    password = await readHidden();
  }

  if (password.length < MIN) {
    console.error(`Password must be at least ${MIN} characters.`);
    process.exit(1);
  }

  const hash = await hashOperatorPassword(password);
  console.log('\nAdd this to the API service environment:');
  console.log(`\nOPERATOR_PASSWORD_HASH=${hash}\n`);
  console.log('After changing it, revoke outstanding sessions:');
  console.log('  npm run revoke-operator-sessions');
}

await main();
