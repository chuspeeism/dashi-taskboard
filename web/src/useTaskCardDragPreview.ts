import { useEffect, useState, type DragEvent } from "react";

interface TaskCardDragPreviewOptions {
  tasks: readonly { id: string }[];
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  isDropTarget: boolean;
}

export function useTaskCardDragPreview({
  tasks,
  draggedTaskId,
  draggedTaskHeight,
  isDropTarget,
}: TaskCardDragPreviewOptions) {
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingTasks = tasks.filter((task) => task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingTasks.map((task, index) => [task.id, index]));
  const draggedTaskIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingTasks.length
    : remainingTasks.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
  }, [draggedTaskId, isDropTarget]);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((card) => card.dataset.taskId !== draggedTaskId);
    return cards.find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  function clearDropPreview() {
    setDropBeforeTaskId(undefined);
  }

  function updateDropPreview(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
  }

  function leaveDropPreview(event: DragEvent<HTMLElement>) {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      clearDropPreview();
    }
  }

  function getTaskDragShift(taskId: string): number {
    if (!draggedTaskId || taskId === draggedTaskId) return 0;
    let shift = 0;
    const taskIndex = taskIndexes.get(taskId) ?? -1;
    const remainingIndex = remainingIndexes.get(taskId) ?? -1;

    if (draggedTaskIndex >= 0 && taskIndex > draggedTaskIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  return { findDropBefore, clearDropPreview, updateDropPreview, leaveDropPreview, getTaskDragShift };
}
