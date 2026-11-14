"""Validate inputs and draw SQL-returned geometry without transforming it."""

import json

import matplotlib.pyplot as plt
import seaborn as sns
from IPython.display import Markdown, display


def validate(mode):
    if mode not in ("raw", "clip", "merge"):
        raise ValueError("TILE_EDGES must be 'raw', 'clip' or 'merge'")


def draw_geometry(ax, payload, color):
    geometry = json.loads(payload)
    kind, coordinates = geometry["type"], geometry["coordinates"]
    if kind == "LineString":
        ax.plot(*zip(*coordinates, strict=True), color=color, linewidth=2)
    elif kind == "MultiLineString":
        for line in coordinates:
            ax.plot(*zip(*line, strict=True), color=color, linewidth=2)
    elif kind in ("Polygon", "MultiPolygon"):
        polygons = [coordinates] if kind == "Polygon" else coordinates
        for polygon in polygons:
            for ring in polygon:
                x, y = zip(*ring, strict=True)
                ax.fill(x, y, facecolor=color, edgecolor=color, alpha=0.22, linewidth=1.5)
    else:
        raise ValueError(f"Unexpected geometry: {kind}")


def prose(text: str) -> None:
    display(Markdown(text))


def theme() -> None:
    sns.set_theme(
        style="whitegrid",
        rc={
            "figure.dpi": 145,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "grid.color": "#E8EDE9",
            "text.color": "#243B2F",
            "axes.labelcolor": "#405047",
            "text.parse_math": False,
            "legend.frameon": False,
        },
    )


def chart(fig, title: str, subtitle: str, source: str) -> None:
    fig.text(0.08, 0.98, title, ha="left", va="top", fontsize=17, fontweight="semibold")
    fig.text(0.08, 0.90, subtitle, ha="left", va="top", fontsize=10, color="#58685F")
    fig.tight_layout(rect=(0.02, 0.11, 1, 0.82))
    fig.text(0.08, 0.03, source, fontsize=8, color="#6C7D73")
    plt.show()
