import * as clack from '@clack/prompts';

const ELLIPSIS = clack.unicodeOr('…', '...');

/** Thrown when the person cancels a prompt (Ctrl+C or Esc). */
export class Cancelled extends Error {
  constructor() {
    super('Stopped.');
    this.name = 'Cancelled';
  }
}

/** A problem the person can fix. `fix` is printed under the message. */
export class InstallError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

interface SelectOption<V> {
  value: V;
  label: string;
  hint?: string;
}

/** Everything that asks the person something. Tests and --answers never reach it. */
interface Prompter {
  text(opts: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  password(opts: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  select<V>(opts: { message: string; options: SelectOption<V>[]; initialValue?: V }): Promise<V>;
  multiselect<V>(opts: {
    message: string;
    options: SelectOption<V>[];
    initialValues?: V[];
  }): Promise<V[]>;
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

export const clackPrompter: Prompter = {
  async text(opts) {
    const validate = opts.validate;
    return unwrap(
      await clack.text({
        message: opts.message,
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
        ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
        ...(validate ? { validate: (value?: string) => validate((value ?? '').trim()) } : {}),
      }),
    ).trim();
  },
  async password(opts) {
    const validate = opts.validate;
    return unwrap(
      await clack.password({
        message: opts.message,
        ...(validate ? { validate: (value?: string) => validate((value ?? '').trim()) } : {}),
      }),
    ).trim();
  },
  async confirm(opts) {
    return unwrap(
      await clack.confirm({
        message: opts.message,
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
      }),
    );
  },
  async select<V>(opts: { message: string; options: SelectOption<V>[]; initialValue?: V }) {
    const options = opts.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.hint ? { hint: o.hint } : {}),
    }));
    return unwrap(
      await clack.select<V>({
        message: opts.message,
        options: options as Parameters<typeof clack.select<V>>[0]['options'],
        ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
      }),
    );
  },
  async multiselect<V>(opts: { message: string; options: SelectOption<V>[]; initialValues?: V[] }) {
    const options = opts.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.hint ? { hint: o.hint } : {}),
    }));
    return unwrap(
      await clack.multiselect<V>({
        message: opts.message,
        options: options as Parameters<typeof clack.multiselect<V>>[0]['options'],
        required: false,
        ...(opts.initialValues ? { initialValues: opts.initialValues } : {}),
      }),
    );
  },
};

/** A prompter for non-interactive runs: any question is a bug in the caller or a missing answer. */
export const noPrompter: Prompter = {
  text: (o) => Promise.reject(missing(o.message)),
  password: (o) => Promise.reject(missing(o.message)),
  confirm: (o) => Promise.reject(missing(o.message)),
  select: (o) => Promise.reject(missing(o.message)),
  multiselect: (o) => Promise.reject(missing(o.message)),
};

function missing(question: string) {
  return new InstallError(
    `This run is non-interactive, but it needs an answer to: ${question}`,
    'Add the answer to the --answers file, or run without --answers to be asked.',
  );
}

export interface Ui {
  prompts: Prompter;
  /** Runs one action and prints "<title>… done" (or "failed"). */
  task<T>(title: string, run: () => Promise<T>, doneText?: (result: T) => string): Promise<T>;
  section(title: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, fix?: string): void;
  note(title: string, body: string): void;
  /** Detail lines, such as the dry-run action log. */
  detail(message: string): void;
}

/** Plain console output. Kept free of colour codes so logs and Windows consoles read cleanly. */
export function consoleUi(
  prompts: Prompter,
  write: (s: string) => void = (s) => process.stdout.write(s),
): Ui {
  let open = false; // a task line is waiting for its "done"
  const breakLine = () => {
    if (open) write('\n');
    open = false;
  };
  const line = (s: string) => {
    breakLine();
    write(`${s}\n`);
  };
  return {
    prompts,
    async task(title, run, doneText) {
      breakLine();
      write(`${title}${ELLIPSIS} `);
      open = true;
      try {
        const result = await run();
        const done = doneText ? doneText(result) : 'done';
        if (open) write(`${done}\n`);
        else write(`${title}${ELLIPSIS} ${done}\n`);
        open = false;
        return result;
      } catch (error) {
        if (open) write('failed\n');
        else write(`${title}${ELLIPSIS} failed\n`);
        open = false;
        throw error;
      }
    },
    section(title) {
      breakLine();
      write(`\n${title}\n`);
    },
    info: (m) => line(m),
    warn: (m) => line(`Warning: ${m}`),
    error(m, fix) {
      line(`Error: ${m}`);
      if (fix) line(`Fix: ${fix}`);
    },
    note(title, body) {
      breakLine();
      write(`\n${title}\n`);
      for (const l of body.split('\n')) write(`  ${l}\n`);
    },
    detail: (m) => line(`  ${m}`),
  };
}
