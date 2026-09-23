/** Parse all arguments before configuration, processes or files are touched. */
export function parseGatewayRestartArguments(argv) {
  const modes = new Set(['--status', '--preflight-only', '--execute', '--help']);
  const values = new Set(['--config-dir', '--task-name', '--delay-seconds']);
  const result = { mode: 'help', configDir: null, taskName: 'DevSpace-Stable-Gateway', delaySeconds: 6 };
  const seen = new Set();
  let selected = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate restart argument: ${flag}`);
    seen.add(flag);
    if (modes.has(flag)) {
      if (selected) throw new Error('Choose exactly one of --status, --preflight-only, --execute or --help.');
      selected = true; result.mode = flag.slice(2); continue;
    }
    if (!values.has(flag)) throw new Error(`Unknown restart argument: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (flag === '--config-dir') result.configDir = value;
    if (flag === '--task-name') result.taskName = value.trim();
    if (flag === '--delay-seconds') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) throw new Error('--delay-seconds must be an integer from 0 to 300.');
      result.delaySeconds = parsed;
    }
  }
  if (!result.taskName) throw new Error('--task-name must not be blank.');
  if (!selected && argv.length) throw new Error('An explicit --status, --preflight-only or --execute mode is required.');
  return result;
}
