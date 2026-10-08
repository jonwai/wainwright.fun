// The hosted handlers read table names from the environment when they load. On the home network
// they are logical names the Postgres adapter maps (see pg-ddb.ts). Import this module first.
import { LOGICAL_TABLES } from "./pg-ddb.js";

process.env.TASKS_TABLE = LOGICAL_TABLES.tasks;
process.env.TASK_COMPLETIONS_TABLE = LOGICAL_TABLES.completions;
process.env.JOB_BOARD_TABLE = LOGICAL_TABLES.board;
process.env.REWARDS_TABLE = LOGICAL_TABLES.rewards;
process.env.REDEMPTIONS_TABLE = LOGICAL_TABLES.redemptions;
process.env.TERM_DATES_TABLE = LOGICAL_TABLES.termDates;
process.env.DEVICES_TABLE ??= "devices";
process.env.PAIRING_TABLE ??= "pairing";
// Icon uploads are written to disk by the local server, never to S3.
process.env.CONFIG_BUCKET_NAME = "";
