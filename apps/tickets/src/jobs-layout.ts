/**
 * How the jobs page groups work.
 *
 * Household chores this child has claimed sit at the top. Chores they can
 * undo (their latest completion) sit at the bottom with finished ticket jobs.
 * Everything else stays in its room, including holds and other children's
 * claims. Empty rooms stay so the switcher does not jump after a claim.
 */

export interface LayoutChore {
  can_undo: boolean;
  claim: { mine: boolean } | null;
}

export interface LayoutRoom<C extends LayoutChore> {
  id: string;
  name: string;
  chores: C[];
}

export interface PlacedChore<C extends LayoutChore> {
  chore: C;
  roomId: string;
  /** Home Assistant area name, unchanged. */
  roomName: string;
}

export interface SplitHousehold<C extends LayoutChore> {
  claimed: PlacedChore<C>[];
  done: PlacedChore<C>[];
  rooms: LayoutRoom<C>[];
}

export function splitHousehold<C extends LayoutChore>(rooms: LayoutRoom<C>[]): SplitHousehold<C> {
  const claimed: PlacedChore<C>[] = [];
  const done: PlacedChore<C>[] = [];
  const nextRooms = rooms.map((room) => {
    const remaining: C[] = [];
    for (const chore of room.chores) {
      const placed = { chore, roomId: room.id, roomName: room.name };
      if (chore.can_undo) done.push(placed);
      else if (chore.claim?.mine === true) claimed.push(placed);
      else remaining.push(chore);
    }
    return { ...room, chores: remaining };
  });
  return { claimed, done, rooms: nextRooms };
}

export interface LayoutTask {
  done: boolean;
}

export function splitTasks<T extends LayoutTask>(tasks: T[]): { open: T[]; done: T[] } {
  return {
    open: tasks.filter((task) => !task.done),
    done: tasks.filter((task) => task.done),
  };
}
