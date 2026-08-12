// The five commands this surface keeps unchanged for one release
// (MILESTONES.md #39): list, show, create, update, status. Each validates
// its own input against the reduced `ShimTask` shape *before* touching the
// network — a malformed command never reaches the server, the same
// separation `src/lib/cli/args.ts` draws for the standup command line, kept
// here as its own copy rather than a shared one (`args.ts`'s own header).
import { isShimStatus, SHIM_STATUSES, stateForStatus, type ShimTask } from "./contract";
import {
  createTask,
  getTask,
  listTasks,
  transitionTask,
  updateTask,
  type ShimClientOptions,
  type ShimResult,
} from "./client";

export interface CommandStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** One line of JSON, exactly what this surface has always printed. */
function printTask(streams: CommandStreams, task: ShimTask): void {
  streams.out(`${JSON.stringify(task, null, 2)}\n`);
}

function printError(streams: CommandStreams, message: string): number {
  streams.err(`Error: ${message}\n`);
  return 1;
}

async function reportResult(
  streams: CommandStreams,
  result: ShimResult<ShimTask>,
): Promise<number> {
  if (!result.ok) return printError(streams, result.message);
  printTask(streams, result.data);
  return 0;
}

const STATUS_LIST = SHIM_STATUSES.join(", ");

export async function runList(
  flags: Readonly<Record<string, string>>,
  client: ShimClientOptions,
  streams: CommandStreams,
): Promise<number> {
  const status = flags.status;
  if (status !== undefined && status !== "" && !isShimStatus(status)) {
    return printError(streams, `unknown status "${status}". Known statuses: ${STATUS_LIST}.`);
  }

  const result = await listTasks(client, {
    ...(status !== undefined && status !== "" ? { state: stateForStatus(status) } : {}),
    ...(flags.repo !== undefined && flags.repo !== "" ? { repo: flags.repo } : {}),
    ...(flags.area !== undefined && flags.area !== "" ? { area: flags.area } : {}),
  });

  if (!result.ok) return printError(streams, result.message);
  streams.out(`${JSON.stringify({ tasks: result.data }, null, 2)}\n`);
  return 0;
}

export async function runShow(
  rest: readonly string[],
  client: ShimClientOptions,
  streams: CommandStreams,
): Promise<number> {
  const id = rest[0];
  if (id === undefined) return printError(streams, "`task show` needs an id.");
  return reportResult(streams, await getTask(client, id));
}

export async function runCreate(
  flags: Readonly<Record<string, string>>,
  client: ShimClientOptions,
  streams: CommandStreams,
): Promise<number> {
  const title = flags.title;
  if (title === undefined || title === "") return printError(streams, "--title is required.");
  const body = flags.body;
  if (body === undefined) return printError(streams, "--body is required.");
  const area = flags.area;
  if (area === undefined || area === "") return printError(streams, "--area is required.");

  return reportResult(
    streams,
    await createTask(client, {
      title,
      body,
      area,
      ...(flags.repo !== undefined && flags.repo !== "" ? { repo: flags.repo } : {}),
    }),
  );
}

export async function runUpdate(
  rest: readonly string[],
  flags: Readonly<Record<string, string>>,
  client: ShimClientOptions,
  streams: CommandStreams,
): Promise<number> {
  const id = rest[0];
  if (id === undefined) return printError(streams, "`task update` needs an id.");

  const edits: { title?: string; body?: string; repo?: string; area?: string } = {};
  if (flags.title !== undefined && flags.title !== "") edits.title = flags.title;
  if (flags.body !== undefined) edits.body = flags.body;
  if (flags.repo !== undefined && flags.repo !== "") edits.repo = flags.repo;
  if (flags.area !== undefined && flags.area !== "") edits.area = flags.area;

  if (Object.keys(edits).length === 0) {
    return printError(
      streams,
      "nothing to update — supply at least one of --title, --body, --repo, --area.",
    );
  }

  return reportResult(streams, await updateTask(client, id, edits));
}

export async function runStatus(
  rest: readonly string[],
  client: ShimClientOptions,
  streams: CommandStreams,
): Promise<number> {
  const id = rest[0];
  const status = rest[1];
  if (id === undefined || status === undefined) {
    return printError(streams, "`task status` needs an id and a status.");
  }
  if (!isShimStatus(status)) {
    return printError(streams, `unknown status "${status}". Known statuses: ${STATUS_LIST}.`);
  }

  return reportResult(streams, await transitionTask(client, id, stateForStatus(status)));
}
