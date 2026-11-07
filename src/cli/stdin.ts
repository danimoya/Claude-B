import type { Readable } from 'node:stream';

/** Read literal UTF-8 prompt data only when the command reaches submission. */
export function createPromptReader(input: Readable & { isTTY?: boolean }) {
  let piped: Promise<string | undefined> | undefined;
  return (parts: string[]): Promise<string | undefined> => {
    // Positional arguments retain normal CLI behavior and never wait for stdin.
    if (parts.length > 0) return Promise.resolve(parts.join(' '));
    if (input.isTTY) return Promise.resolve(undefined);
    // Cache the input so daemon-start retry cannot consume an exhausted pipe.
    piped ??= (async () => {
      input.setEncoding('utf8');
      let text = '';
      for await (const chunk of input) text += chunk;
      return text.length > 0 ? text : undefined;
    })();
    return piped;
  };
}
