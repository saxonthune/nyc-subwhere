export interface DropTally {
  total: number;
  rendered: number;
  drops: Map<string, number>;
}

export class StatsPanel {
  private readonly content: HTMLDivElement;
  private open = false;

  constructor() {
    const button = document.createElement("button");
    button.className = "stats-panel-toggle";
    button.textContent = "Advanced Stats";

    this.content = document.createElement("div");
    this.content.className = "stats-panel-content";
    this.content.hidden = true;

    button.addEventListener("click", () => {
      this.open = !this.open;
      this.content.hidden = !this.open;
    });

    document.body.appendChild(button);
    document.body.appendChild(this.content);
  }

  update(tally: DropTally): void {
    if (!this.open) return;

    const dropped = tally.total - tally.rendered;
    const lines = [
      `total: ${tally.total}`,
      `rendered: ${tally.rendered}`,
      `dropped: ${dropped}`,
      ...[...tally.drops.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => {
          const [cause, routeId] = key.split(":");
          return `${cause} ${routeId}: ${count}`;
        }),
    ];
    this.content.textContent = lines.join("\n");
  }
}
