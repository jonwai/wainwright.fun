/**
 * Ticket jobs on the jobs page. Household chores are already split by the
 * kid API into assigned chores and done-recently, so they are not grouped here.
 * Open ticket jobs stay in the list; finished ones sit at the bottom.
 */

export interface LayoutTask {
  done: boolean;
}

export function splitTasks<T extends LayoutTask>(tasks: T[]): { open: T[]; done: T[] } {
  return {
    open: tasks.filter((task) => !task.done),
    done: tasks.filter((task) => task.done),
  };
}
