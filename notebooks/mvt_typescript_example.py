"""Render returned vector tile results without analytical geometry calculations."""

import hashlib
import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from vgi_notebooks import finish

from map_support import draw_geometry as draw_payload


def draw_geometry(ax, payload, color):
    draw_payload(ax, json.loads(payload), color)


def validate_mode(value):
    if value not in {"raw", "clip", "merge"}:
        raise ValueError("TILE_EDGES must be raw, clip or merge")


def validate_x(value):
    if type(value) is not int or value not in {1, 2}:
        raise ValueError("ASSIGNED_X must be integer 1 or 2")


def verify_fixtures():
    for item in json.loads(Path("fixtures/provenance.json").read_text())["files"]:
        data = (Path("fixtures") / item["file"]).read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Fixture differs from published bytes")


def edge_map(geometry_frame, TILE_EDGES):
    colors = {"Four tiles": "#327659", "One tile": "#af713d", "Diagonal": "#426db3", "Short": "#8964a3"}
    fig, axes = plt.subplots(1, 2, figsize=(11.5, 7.2), sharex=True, sharey=True)
    for ax, reading, mode in zip(axes, ["Selected", "Clipped reference"], [TILE_EDGES, "clip"], strict=True):
        subset = geometry_frame[geometry_frame.reading == reading]
        for item in subset.itertuples():
            draw_geometry(ax, item.geometry_json, colors[item.feature_name])
        ax.axvline(0, color="#88968d", ls=":", lw=1)
        ax.axhline(5009.3770856973, color="#88968d", ls=":", lw=1)
        ax.set(
            title=f"{reading}: {mode} · {len(subset)} rows",
            xlabel="Easting (projected km)",
            xlim=(-2600, 3100),
            ylim=(700, 7800),
        )
        ax.set_aspect("equal", adjustable="box")
    axes[0].set_ylabel("Northing (projected km)")
    fig.legend(
        [Line2D([0], [0], color=color, lw=3) for color in colors.values()],
        list(colors),
        loc="upper center",
        bbox_to_anchor=(0.5, 0.82),
        ncol=4,
        frameon=False,
        fontsize=10,
    )
    finish(
        fig,
        "Tile buffers can overlap without adding new features",
        f"Synthetic archive · zoom 3 · selected policy: {TILE_EDGES} · equal projected scales; no basemap",
        "Source: unchanged edges.pmtiles from VGI MVT TypeScript v0.1.0 test fixtures\n"
        "Actual worker geometry; EPSG:3857 is distorted and these are not ground distances",
        name="01-buffer-geometry",
    )


def edge_measures(comparison_frame, TILE_EDGES):
    fig, axes = plt.subplots(1, 2, figsize=(11.5, 5.8))
    for ax, layer in zip(axes, ["areas", "roads"], strict=True):
        subset = comparison_frame[comparison_frame.layer == layer].reset_index(drop=True)
        positions = list(range(len(subset)))
        ax.bar(
            [i - 0.18 for i in positions],
            subset.clipped_measure,
            width=0.34,
            color="#A2B1A7",
            label="Clipped reference",
        )
        selected = ax.bar(
            [i + 0.18 for i in positions],
            subset.selected_measure,
            width=0.34,
            color="#327659",
            label=f"Selected: {TILE_EDGES}",
        )
        ax.bar_label(
            selected, labels=[f"{v:+.4f}%" for v in subset.difference_percent], padding=5, fontsize=9
        )
        ax.set_xticks(positions, subset.feature_name)
        ax.set_ylabel(subset.units.iloc[0])
        ax.set_title(layer.title())
        ax.legend(fontsize=9)
        ax.set_ylim(0, max(subset.clipped_measure.max(), subset.selected_measure.max()) * 1.30)
    finish(
        fig,
        "Count pieces separately from the space they represent",
        f"Selected policy: {TILE_EDGES} • labels show percentage difference from clipped measure",
        "Synthetic PMTiles archive • worker decoding + Haybarn spatial measures • independent panel units.\n"
        "A lower merged row count does not mean less geographic coverage.",
        name="02-buffer-measures",
    )


def address_changes(points, assigned_x):
    """Render SQL-calculated coordinates and shifts with fixed, distinct units."""
    points = points.sort_values("fixture_label")
    fig, axes = plt.subplots(1, 2, figsize=(13, 6.3))
    left, right = axes
    for row in points.itertuples():
        left.plot(
            [row.reference_lon, row.selected_lon],
            [row.reference_lat, row.selected_lat],
            color="#9ba9a0",
            linewidth=1,
        )
        left.scatter(row.reference_lon, row.reference_lat, color="#327659", s=45, zorder=3)
        left.scatter(row.selected_lon, row.selected_lat, color="#ba713d", marker="x", s=65, zorder=4)
        left.annotate(
            row.fixture_label,
            (row.selected_lon, row.selected_lat),
            xytext=(4, 5),
            textcoords="offset points",
            fontsize=9,
        )
    left.set(
        xlim=(-100, 40),
        ylim=(40, 60),
        xlabel="Longitude (degrees east)",
        ylabel="Latitude (degrees north)",
        title="Four fixture points; no basemap",
    )
    left.legend(
        handles=[
            Line2D([0], [0], marker="o", linestyle="", color="#327659", label="Recorded address: 2/2/1"),
            Line2D(
                [0],
                [0],
                marker="x",
                linestyle="",
                color="#ba713d",
                label=f"Assigned address: 2/{assigned_x}/1",
            ),
        ],
        loc="lower left",
        fontsize=9,
    )
    bars = right.barh(points.fixture_label, points.easting_change_m / 1000, color="#ba713d", height=0.55)
    right.bar_label(
        bars, labels=[f"{x / 1000:+,.1f}" for x in points.easting_change_m], padding=4, fontsize=9
    )
    right.invert_yaxis()
    right.axvline(0, color="#526b5b", linewidth=1)
    right.set(
        xlim=(-12000, 1000),
        xlabel="Signed easting change in EPSG:3857 (km)",
        title="Selected minus recorded address",
    )
    finish(
        fig,
        "Valid geometry does not certify the supplied tile address",
        f"Same unchanged bytes · zoom 2 / Y = 1 · assigned X = {assigned_x} · reference X = 2",
        "Source: unchanged GDAL XYZ 2/2/1 test tile · city labels/attributes are fixture values, "
        "not current place data\n"
        "VGI MVT TypeScript v0.1.0 · projected changes are not ground distances; "
        "no location accuracy is inferred",
        name="03-address-provenance",
    )
