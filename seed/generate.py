#!/usr/bin/env python3
"""generate.py -- synthetic data generator for the Kerbline demo.

No real vehicle footage, and no real identifiable person, is involved anywhere
in this script, its output, or the rest of this repository. Kerbline Ltd is a
fictional company invented for this demo (see docs/SCENARIO.md). Every row comes
from a fixed random seed and every ClipId is prefixed "SYN-", so nobody has to
ask, from the floor or in review, whether it is real. No number plates are
generated at all; see the note above make_vin.

What this script does
----------------------
Writes JSON files into ``--out`` (default: ``seed/out/``, already gitignored
-- generated data is never committed, only this generator is):

  * catalog.json               -- the seven datasets from SCENARIO.md Section 3,
                                   with classification, residency, volume,
                                   owner and a per-dataset ``columns`` block.
                                   The access-decision workflow reads it to make
                                   allow/deny calls, and it is the only place
                                   column metadata is written down: the
                                   gateway's ``describe_dataset``, aggregate and
                                   record routes all read it, so none can drift.
  * clip_index.sample.json     -- ~300 display rows of the annotated-clip
                                   index: per-clip GPS position, timestamp,
                                   vehicle, lighting/weather/road class and a
                                   per-label-class annotation breakdown.
  * clip_catalog.sample.json   -- ~300 rows of the INTERNAL clip catalog,
                                   which carries no vehicle, no position and
                                   no timestamp. See
                                   CLIP_CATALOG_COLUMNS for why that omission
                                   is the point rather than an oversight.
  * redacted_research.sample.json -- ~300 rows of the CONFIDENTIAL redacted
                                   research subset.
  * gpu_metrics.sample.json    -- a few hundred rows of plausible GPU cluster
                                   telemetry.
  * oem_programmes.sample.json -- ~50 rows of de_DE OEM programme
                                   accounts and contacts.
  * infra_spend.sample.json    -- ~50 rows of GPU and storage spend by cost
                                   centre.
  * MANIFEST.json              -- what was generated, with which seed, so a
                                   run is reproducible and auditable.

Sample rows and full rows
-------------------------
The ``*.sample.json`` files are the readable artifacts: a few hundred rows each,
small enough to open in an editor and diff by eye. The gateway serves them when
nothing bigger has been generated.

``--full`` also writes the datasets at SCENARIO.md Section 3's stated volumes,
into ``<out>/full/``. That is what makes an aggregate an aggregate: a lighting
breakdown over 300 display rows is not the figure beat 3 claims it is, however
plausible it looks on a slide. The full files run to tens of megabytes, so they
are written compact rather than indented, and never committed -- see .gitignore.

One dataset is deliberately generated over a shorter window than the catalog
claims: see GPU_FULL_WINDOW_HOURS.

Every standard referenced below (ASAM OpenLABEL, ASAM MDF4, ISO 3779, WGS84,
ISO 8601) was checked against a primary or near-primary source first. See
``seed/CODES.md`` for each citation and confidence note, including what could
and could not be confirmed.

Determinism
-----------
One fixed seed (``DEFAULT_SEED``), declared below and recorded in MANIFEST.json.
All randomness -- numpy and the two auxiliary ``random.Random`` streams for VINs
and GPS -- is seeded from ``--seed``, which defaults to it. Nothing depends on
wall-clock time: dates are computed from the fixed ``AS_OF_DATE`` constant, not
``datetime.now()``. Two runs with the same seed and the same dependency versions
produce byte-identical output.

Dependencies
------------
``numpy`` and ``Faker``, pinned in seed/requirements.txt, because
docs/SCENARIO.md Section 3.4 commits this repo to "Faker(locale='de_DE') +
seeded numpy, fixed seed committed." Faker does the OEM programme contacts
(de_DE names, addresses); the clip index uses numpy and two seeded
``random.Random`` streams, having no need for locale-aware names. A missing
package fails loudly with instructions rather than silently falling back to
lower-quality data: numbers that differ between two clones defeat the point
of seeding a generator.

Usage
-----
    python3 seed/generate.py
    python3 seed/generate.py --full
    python3 seed/generate.py --seed 12345 --out /tmp/some-dir
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

MISSING_DEPS_MSG = """
generate.py requires 'numpy' and 'Faker'. This repo pins exact versions in
seed/requirements.txt for reproducibility -- install them with:

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r seed/requirements.txt
    python3 seed/generate.py

This script does not fall back to a lower-quality generator if these are
missing. A run using different (or missing) dependencies would not
reliably match seed/CODES.md or docs/SCENARIO.md, and silently shipping
numbers the documentation contradicts is the failure this generator exists
to prevent.
""".strip()

try:
    import numpy as np
    from faker import Faker
except ImportError as exc:  # pragma: no cover - exercised by missing-deps path
    print(f"Missing dependency: {exc}\n\n{MISSING_DEPS_MSG}", file=sys.stderr)
    raise SystemExit(1) from exc


# =============================================================================
# Fixed constants -- determinism and provenance
# =============================================================================

# One fixed seed, declared here and recorded verbatim in MANIFEST.json.
# Override with --seed for experimentation; the committed, demo-canonical
# output always comes from this value.
DEFAULT_SEED = 48217

GENERATOR_VERSION = "1.0.0"

# Fixed reference "today" for the scenario. Deliberately NOT datetime.now():
# clip dates and telemetry windows are all computed relative to this constant
# so that running the generator next year still reproduces the same numbers
# as today.
AS_OF_DATE = date(2026, 8, 3)

CLIP_ID_PREFIX = "SYN-"
ORGANISATION = "Kerbline Ltd"
SYNTHETIC_BANNER = (
    "SYNTHETIC DATA -- Kerbline Ltd is a fictional company. "
    "No real vehicle footage and no real identifiable person exists in this "
    "file, or anywhere in this repository. Generated by seed/generate.py "
    "from a fixed seed; see seed/CODES.md for the source of every "
    "standard referenced."
)


# =============================================================================
# Verified standards (see seed/CODES.md for citations and confidence notes)
# =============================================================================

# ASAM OpenLABEL -- annotation format for object labels, tracks and frame
# intervals. Version and release date verified against ASAM's own standard
# page. OpenLABEL deliberately does NOT define a fixed set of object classes;
# it imports the user's own ontology, so LABEL_CLASSES below is
# implementer-defined by design and conflicts with nothing. The literal JSON
# field names are still unverified and no claim is made about them.
# See seed/CODES.md Section 1.
ASAM_OPENLABEL_VERSION = "1.0.0"

# Object label classes used in the per-clip annotation breakdown below. ADAS
# perception categories chosen for this scenario, which is what OpenLABEL
# expects: the standard supplies the data model, the user supplies the taxonomy.
# See seed/CODES.md Section 1.
LABEL_CLASSES = [
    "pedestrian",
    "cyclist",
    "vehicle",
    "truck",
    "bus",
    "motorcycle",
    "traffic_light",
    "traffic_sign",
]

# Per-clip label rate (Poisson mean), before the night-time pedestrian
# adjustment below. Pedestrian is the lowest-common instance count of the
# group -- docs/SCENARIO.md Section 3.2's "skewed low" -- with vehicle and
# traffic-sign counts carrying most of a typical urban clip.
LABEL_CLASS_BASE_RATE: dict[str, float] = {
    "vehicle": 5.5,
    "pedestrian": 1.6,
    "cyclist": 0.6,
    "truck": 0.9,
    "bus": 0.15,
    "motorcycle": 0.25,
    "traffic_light": 1.4,
    "traffic_sign": 2.1,
}

# The night-time subset is skewed lower still (docs/SCENARIO.md Section 3.2).
# This gap is why Lena wants more night data, so it has to show up in the
# generated numbers rather than only in prose.
NIGHT_PEDESTRIAN_MULTIPLIER = 0.35
TWILIGHT_PEDESTRIAN_MULTIPLIER = 0.7

# ASAM MDF4 -- measurement-data format for the bus/sensor channels recorded
# alongside video. Not used to shape any generated field below (no MDF4 files
# are materialised by this generator); recorded here only as the standard
# docs/SCENARIO.md Section 3.2 names for that data. Version verified against
# ASAM's standard page: 4.3.0, released 23 September 2025.
ASAM_MDF4_VERSION = "4.3.0"

# ISO 3779 -- VIN layout: 3-char WMI + 6-char VDS + 8-char VIS = 17 characters.
# A fictional WMI so no generated VIN can be mistaken for a real
# manufacturer's. Position 9 as a check digit is a North American
# requirement (FMVSS/49 CFR 565), not an ISO or EU one, so it is not computed
# or reserved here -- see docs/SCENARIO.md Section 3.2 and seed/CODES.md
# Section 3.
VIN_WMI = "SYN"
# Letters I, O and Q are conventionally excluded from VINs to avoid confusion
# with 1 and 0 -- widely reported, confidence Medium (not checked against the
# ISO 3779 primary text directly; see seed/CODES.md Section 3).
VIN_BODY_CHARSET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789"

# No number plates are generated. An earlier version rendered German-format
# plates into the clip index; they went because nothing reads them. No rule in
# access_policy.yaml and no eval case references a plate, so the field was
# display flavour that cost something: Germany publishes no district code
# reserved for fiction, so any code chosen either collides with a real Kreis or
# is an invented convention presented as a standard.
#
# Removing it also sharpens the point the clip index exists to make. The index
# holds no direct identifier at all, and position plus timestamp still resolves
# to one vehicle and one driver's route. A plate would make that a weaker
# demonstration, not a stronger one.

# Hand-picked, approximate waypoints along real Berlin streets -- order-of-
# magnitude checked against public map coordinates for each named street
# (seed/CODES.md Section 5), not surveyed GPS data. The point is a WGS84-shaped
# value that lands on a road corridor rather than inside the Tiergarten or a
# building footprint, which is what docs/SCENARIO.md Section 3.2 asks for. No
# precision beyond "the right street, the right part of Berlin" is claimed.
BERLIN_ROAD_CORRIDORS: dict[str, list[tuple[float, float]]] = {
    "karl_marx_allee": [
        (52.5205, 13.4245),
        (52.5188, 13.4345),
        (52.5165, 13.4431),
        (52.5145, 13.4505),
    ],
    "frankfurter_allee": [
        (52.5145, 13.4548),
        (52.5110, 13.4680),
        (52.5085, 13.4790),
        (52.5065, 13.4900),
    ],
    "sonnenallee": [
        (52.4870, 13.4400),
        (52.4790, 13.4415),
        (52.4700, 13.4440),
        (52.4595, 13.4460),
    ],
    "muellerstrasse": [
        (52.5460, 13.3550),
        (52.5490, 13.3600),
        (52.5520, 13.3640),
        (52.5545, 13.3670),
    ],
    "potsdamer_strasse_south": [
        (52.4990, 13.3560),
        (52.4930, 13.3540),
        (52.4870, 13.3510),
        (52.4800, 13.3480),
    ],
}


# =============================================================================
# Dataset catalog -- docs/SCENARIO.md Section 3, verbatim
# =============================================================================

# GPU cluster shape used to derive the ~4.1M figure SCENARIO.md gives for
# ops.gpu_cluster_metrics (SCENARIO.md rounds it; this derives a specific,
# non-round figure from a plausible cluster: 12 nodes x 8 GPUs/node, sampled
# every minute for 30 days). Cluster telemetry is domain-neutral and
# unchanged from the previous version of this scenario.
GPU_CLUSTER_NODES = 12
GPU_CLUSTER_GPUS_PER_NODE = 8
GPU_TELEMETRY_DAYS = 30
GPU_TELEMETRY_INTERVAL_MINUTES = 1
GPU_CLUSTER_TOTAL_SAMPLES = (
    GPU_CLUSTER_NODES
    * GPU_CLUSTER_GPUS_PER_NODE
    * GPU_TELEMETRY_DAYS
    * 24
    * 60
    // GPU_TELEMETRY_INTERVAL_MINUTES
)

# THE ONE PLACE WHERE THE GENERATED DATA IS SMALLER THAN THE CATALOG'S FIGURE.
#
# GPU_CLUSTER_TOTAL_SAMPLES is 4,147,200 rows, roughly a gigabyte of JSON.
# Writing a gigabyte into somebody's clone is not a reasonable thing to do, so
# --full materialises 24 hours of the same minute-by-minute grid -- 12 x 8 x 24
# x 60 = 138,240 rows, about 30 MB -- and the catalog keeps 4,147,200 as the
# *stated logical population*, which is what SCENARIO.md Section 3 describes and
# what a real cluster would hold.
#
# The distinction is recorded in as many words in three places: the dataset's
# `note`, its `volume` block as `generated_count` alongside `count`, and
# MANIFEST.json. Nobody should be able to quote 4.1 million samples off a file
# holding 138 thousand. 24 hours comes from the eval set: the largest read any
# case asks for is 17,280 rows over the last 24 hours
# (eval/queries/allow_cluster_telemetry_read.yaml), so the shorter window covers
# every question the demo puts to this dataset.
GPU_FULL_WINDOW_HOURS = 24
GPU_FULL_TOTAL_SAMPLES = (
    GPU_CLUSTER_NODES
    * GPU_CLUSTER_GPUS_PER_NODE
    * GPU_FULL_WINDOW_HOURS
    * 60
    // GPU_TELEMETRY_INTERVAL_MINUTES
)

# One node runs hot and full for the whole window. "Is the cluster healthy
# enough to retrain today?" is half of demo beat 3's question, and a cluster
# where every node looks identical has no answer to it: the answer has to come
# out of the numbers rather than out of the narration.
GPU_SATURATED_NODE_INDEX = 7

# Row counts for the datasets that had no generator before this. Both come
# straight from docs/SCENARIO.md Section 3 rather than being chosen here.
CLIP_ANNOTATED_ROWS = 48217
CLIP_REDACTED_ROWS = 12904
# 61,121 is the sum of the two clip sets, which is what the catalog's own note
# asserts. Note the wording tension with SCENARIO.md, which calls the redacted
# set a "subset": a subset of the annotated set would make the catalog total
# 48,217, not 61,121. The arithmetic wins here because referential integrity is
# what SCENARIO.md Section 3.2 makes non-negotiable -- "catalog counts must
# equal what a query actually returns" -- so the two clip sets are materialised
# as disjoint populations from the same fleet programme, and clip_catalog
# indexes both.
CLIP_CATALOG_ROWS = CLIP_ANNOTATED_ROWS + CLIP_REDACTED_ROWS

INFRA_SPEND_ROWS = 2204
OEM_PROGRAMME_ROWS = 1847

# Per-dataset seed offsets, XORed with --seed, so each dataset draws from its own
# generator. That is what keeps them independent: adding a dataset, or
# regenerating one, cannot shift the numbers in the others. The values are
# arbitrary and only have to be distinct from each other and from 0.
#
# The three datasets that predate these offsets -- the clip index, the telemetry
# sample and the OEM sample -- still share one generator seeded from --seed
# directly. Their committed output was produced that way, and moving them onto
# offsets would rewrite files a reader diffs to check determinism.
SEED_OFFSET_REDACTED = 0x2ED
SEED_OFFSET_GPU_FULL = 0x6C0
SEED_OFFSET_OEM_FULL = 0x0E4
SEED_OFFSET_INFRA = 0x1F5

# How many rows each *.sample.json carries. The clip-index figure is the one
# that must not change: the committed sample was generated with 300 and the
# first 300 rows of the full set are byte-identical to it, which is only true
# while this number and the draw order both stay put.
SAMPLE_CLIP_ROWS = 300
SAMPLE_GPU_ROWS = 360
SAMPLE_OEM_ROWS = 50
SAMPLE_INFRA_ROWS = 50

# Clip-index shape, lifted out of the generator function so the sample and the
# full set provably share it rather than agreeing by inspection.
CLIP_FLEET_SIZE = 24
CLIP_WINDOW_DAYS = 120
CLIP_LIGHTING_OPTIONS = [("day", 0.55), ("night", 0.30), ("twilight", 0.15)]
CLIP_WEATHER_OPTIONS = [
    ("clear", 0.55),
    ("overcast", 0.20),
    ("rain", 0.15),
    ("fog", 0.06),
    ("snow", 0.04),
]
CLIP_ROAD_OPTIONS = [
    ("urban_arterial", 0.35),
    ("residential", 0.30),
    ("secondary_road", 0.20),
    ("motorway_adjacent", 0.15),
]

# Duration bands for fleet.clip_catalog. A band rather than an exact DurationMs
# because access_policy.yaml's R10 notes point out that an exact duration spans
# roughly 4,100 to 58,400 ms across 48,217 clips: close to unique while looking
# innocuous. Banding is what the `coarsen_grouping` sanctioned path asks a caller
# to do, so the INTERNAL catalog does it by construction.
CLIP_DURATION_BANDS: list[tuple[int, str]] = [
    (8000, "under_8s"),
    (15000, "8s_to_15s"),
    (25000, "15s_to_25s"),
    (40000, "25s_to_40s"),
    (10**9, "over_40s"),
]

# Redaction confidence. docs/SCENARIO.md Section 5.1 argues that automated
# redaction is least reliable where night-time recall needs the data most:
# small, distant, poorly-lit figures. That has to be visible in the generated
# numbers, because beat 5 contrasts a run on the restricted set against a run on
# this one, and the contrast has to come out of the data.
REDACTION_CONFIDENCE_BASE = 0.94
REDACTION_NIGHT_PENALTY = 0.17
REDACTION_TWILIGHT_PENALTY = 0.07
REDACTION_WEATHER_PENALTY = {"clear": 0.0, "overcast": 0.02, "rain": 0.06, "fog": 0.11, "snow": 0.08}
# A clip full of pedestrians has more small, distant figures to miss than a
# clip with one close-up, so confidence falls as the pedestrian count rises.
REDACTION_PER_PEDESTRIAN_PENALTY = 0.012

# Cost centres for finance.infra_spend_fy26q3. Deliberately skewed: the eval
# case edge_case_confidential_aggregate_small_cohort exists to prove the
# k-anonymity floor is scoped to RESTRICTED data, and it does that by grouping a
# CONFIDENTIAL dataset into groups of a handful of rows. That case is only
# testing anything if some cost centres really do hold a handful of line items.
INFRA_COST_CENTRES: list[tuple[str, float]] = [
    ("CC-1010 Perception R&D", 0.34),
    ("CC-1020 Platform Engineering", 0.26),
    ("CC-1030 Data Collection Fleet", 0.19),
    ("CC-1040 Annotation Operations", 0.14),
    ("CC-2010 Commercial", 0.045),
    ("CC-3010 Finance", 0.015),
    ("CC-9010 Board & Governance", 0.008),
    ("CC-9020 Works Council", 0.002),
]
INFRA_CATEGORIES = [
    "gpu_compute_hours",
    "object_storage",
    "block_storage",
    "network_egress",
    "annotation_tooling_licences",
]
INFRA_VENDORS = ["Nordwerk Cloud GmbH", "Elbstrom Rechenzentrum AG", "Havelwerk Storage GmbH"]
INFRA_QUARTER_MONTHS = ["2026-04", "2026-05", "2026-06"]


# =============================================================================
# Column metadata -- the single source, written into catalog.json
#
# Nothing wrote column metadata down before this. The gateway's
# `describe_dataset` needs it, its aggregate route needs to know which column
# names exist, and the policy oracle reads the same catalog. Three hardcoded
# copies of a schema is three schemas, so this is the only copy; they all
# resolve it from catalog.json.
#
# `kind` distinguishes three things a caller can name in a `columns` list:
#
#   stored -- a top-level key on every row.
#   nested -- an object of its own, not groupable as a single dimension.
#   pseudo -- not stored anywhere: a dimension the aggregate route synthesises.
#             `label_class` is the only one, and it exists because the eval set
#             groups by it (eval/queries/allow_r2_aggregate_k25_boundary.yaml)
#             while the rows hold it as the per-label key inside `labels`. An
#             aggregate route that only understood stored columns would refuse
#             a query the policy allows, which is the wall behaviour this whole
#             repository is arguing against.
# =============================================================================


def col(name: str, ctype: str, description: str, kind: str = "stored") -> dict[str, str]:
    return {"name": name, "type": ctype, "kind": kind, "description": description}


LABEL_COLUMNS = [
    col("LabelCount", "integer", "Total annotated object instances across every label class."),
    col(
        "labels",
        "object",
        "Per-label-class instance counts, keyed by class name: "
        + ", ".join(LABEL_CLASSES)
        + ".",
        kind="nested",
    ),
    col(
        "label_class",
        "string",
        "Not a stored column. The per-label key inside `labels`, exposed as a "
        "groupable dimension so an aggregate can break a measure down by object "
        "class. Grouping by it puts every clip in the cohort into every class's "
        "group, because every row carries a count for every class.",
        kind="pseudo",
    ),
]

CLIP_INDEX_COLUMNS = [
    col("ClipId", "string", "Synthetic clip identifier, always prefixed SYN-."),
    col("VehicleId", "string", "ISO 3779-shaped VIN of the recording vehicle."),
    col("GpsLatitude", "number", "WGS84 decimal degrees, on a Berlin road corridor."),
    col("GpsLongitude", "number", "WGS84 decimal degrees, on a Berlin road corridor."),
    col("RecordedAt", "string", "ISO 8601 timestamp with a Europe/Berlin offset."),
    col("LightingCondition", "string", "One of day, night, twilight."),
    col("WeatherCondition", "string", "One of clear, overcast, rain, fog, snow."),
    col("RoadClass", "string", "One of urban_arterial, residential, secondary_road, motorway_adjacent."),
    col("DurationMs", "integer", "Clip length in milliseconds, log-normal, 4,000 to 180,000."),
    *LABEL_COLUMNS,
]

# The four columns fleet.clip_catalog does NOT have, and why. Rung 4c of
# docs/SCENARIO.md Section 5 argues that stripping the video off the restricted
# set's index still leaves a movement trace, and a movement trace is a person:
# the index carries GpsLatitude, GpsLongitude, RecordedAt and VehicleId, which is
# where a specific car was and when. That argument needs a contrast to draw, and
# the contrast is this dataset. Give the INTERNAL catalog a vehicle, a position
# or a timestamp and the ladder loses its most instructive rung: the one where
# two datasets over the same clips answer differently because of what their
# columns are, not how many rows they have.
CLIP_CATALOG_COLUMNS = [
    col("ClipId", "string", "Synthetic clip identifier, always prefixed SYN-."),
    col("SourceDataset", "string", "Which clip set this row indexes: annotated or redacted_research."),
    col("LightingCondition", "string", "One of day, night, twilight."),
    col("WeatherCondition", "string", "One of clear, overcast, rain, fog, snow."),
    col("RoadClass", "string", "One of urban_arterial, residential, secondary_road, motorway_adjacent."),
    col(
        "DurationBand",
        "string",
        "Clip length as a band rather than an exact value: "
        + ", ".join(band for _, band in CLIP_DURATION_BANDS)
        + ".",
    ),
    *LABEL_COLUMNS,
]

REDACTED_RESEARCH_COLUMNS = [
    col("ClipId", "string", "Synthetic clip identifier, always prefixed SYN-RDX-."),
    col("LightingCondition", "string", "One of day, night, twilight."),
    col("WeatherCondition", "string", "One of clear, overcast, rain, fog, snow."),
    col("RoadClass", "string", "One of urban_arterial, residential, secondary_road, motorway_adjacent."),
    col("DurationMs", "integer", "Clip length in milliseconds."),
    col(
        "RedactionConfidence",
        "number",
        "Automated-redactor confidence that every face and plate in the clip was "
        "found and blurred, 0 to 1. Falls in darkness, in poor weather and as the "
        "pedestrian count rises -- see docs/SCENARIO.md Section 5.1.",
    ),
    col(
        "RedactionQuality",
        "string",
        "RedactionConfidence as a band: high, medium or low. Derived, not measured "
        "separately.",
    ),
    *LABEL_COLUMNS,
]

GPU_METRICS_COLUMNS = [
    col("node", "string", "Cluster node, dgx-01 to dgx-12."),
    col("gpu_index", "integer", "GPU ordinal within the node, 0 to 7."),
    col("timestamp", "string", "ISO 8601 UTC sample time, one sample per minute."),
    col("gpu_utilization_pct", "number", "Percent utilisation at the sample instant."),
    col("gpu_memory_used_gb", "number", "Device memory in use, GB."),
    col("gpu_memory_total_gb", "integer", "Device memory fitted, GB."),
    col("job_id", "string", "Scheduler job holding the GPU, or null when idle."),
]

OEM_PROGRAMME_COLUMNS = [
    col("programme_id", "string", "Programme identifier, OEM-0001 upwards."),
    col("account_name", "string", "Manufacturer account. Every name is fictional."),
    col("programme_name", "string", "Internal platform codename and vehicle segment."),
    col("address", "object", "Street, postal code, city and country of the account.", kind="nested"),
    col("contact_name", "string", "Programme manager, de_DE locale."),
    col("contact_title", "string", "Job title."),
    col("contact_email", "string", "Work email address."),
    col("phone", "string", "Work telephone number."),
]

INFRA_SPEND_COLUMNS = [
    col("line_item_id", "string", "Ledger line identifier, FY26Q3-0001 upwards."),
    col("cost_centre", "string", "Owning cost centre, e.g. CC-1010 Perception R&D."),
    col("category", "string", "One of " + ", ".join(INFRA_CATEGORIES) + "."),
    col("month", "string", "Accounting month, YYYY-MM, within FY26 Q3."),
    col("vendor", "string", "Supplier. Every name is fictional."),
    col("amount_eur", "number", "Line amount in euro."),
]


@dataclass(frozen=True)
class Dataset:
    id: str
    description: str
    classification: str
    residency: str
    count: int
    unit: str
    owner: str
    notes: str = ""
    size_mb: int | None = None
    # Column metadata, and the file stem the generator writes rows to. Both are
    # emitted into catalog.json so the gateway has one place to resolve a
    # dataset's schema and one place to find its rows. `None` on an artifact
    # that has no tabular rows at all.
    columns: list[dict[str, str]] | None = None
    stem: str | None = None
    # Set only where --full generates fewer rows than `count`; see
    # GPU_FULL_WINDOW_HOURS for the only case and the reasoning.
    generated_count: int | None = None
    # Provenance for derived artifacts: the id of the dataset this came from.
    # Only the source id, never a copy of its classification, so the two cannot
    # drift; a consumer resolves the classification from the referenced dataset.
    # Policy rule R7 gates on this, and it is the only reason the gateway can
    # tell that a set of weights carries its training data's residency
    # constraint. Structured data rather than prose because both the policy
    # oracle and the n8n gateway read it, and two independent hardcoded copies
    # would make comparing them circular.
    derived_from: str | None = None


CATALOG_DATASETS: list[Dataset] = [
    Dataset(
        id="fleet.night_clips_annotated",
        description="Camera and lidar clips with annotation labels. Faces and plates visible.",
        classification="RESTRICTED",
        residency="EU-DE-ONLY",
        count=CLIP_ANNOTATED_ROWS,
        unit="clips",
        owner="Perception",
        columns=CLIP_INDEX_COLUMNS,
        stem="clip_index",
        notes=(
            "Ordinary personal data under GDPR Article 6, not special "
            "category data under Article 9 -- see docs/SCENARIO.md Section "
            "3.1. Recordings stay in the enclave because the data subjects "
            "are strangers filmed in public who were never asked and "
            "cannot be found afterwards, which closes off the lawful basis "
            "the company would otherwise reach for -- not because the law "
            "forbids the data from moving. Records never leave the "
            "enclave (policy rule R1); aggregates over >=25 records may "
            "(R2)."
        ),
    ),
    Dataset(
        id="fleet.night_clips_redacted_research",
        description="Redacted subset, faces and plates blurred, labels retained",
        classification="CONFIDENTIAL",
        residency="EU",
        count=CLIP_REDACTED_ROWS,
        unit="clips",
        owner="Perception",
        columns=REDACTED_RESEARCH_COLUMNS,
        stem="redacted_research",
        notes=(
            "Faces and plates blurred; annotation labels retained. Offered "
            "as the local-iteration redirect (sanctioned path "
            "use_redacted_set) -- redaction is least reliable exactly where "
            "it matters most for night-time recall, so this set "
            "complements the restricted one rather than replacing it (see "
            "docs/SCENARIO.md Section 5.1). Carries no VehicleId, no GPS "
            "position and no timestamp: removing the identifying detail is "
            "what places this set at CONFIDENTIAL rather than RESTRICTED, "
            "which is the classification ladder's own definition of the "
            "level. Each row instead carries a RedactionConfidence, so the "
            "reliability argument can be measured off the data rather than "
            "asserted over it."
        ),
    ),
    Dataset(
        id="fleet.clip_catalog",
        description="Clip metadata only -- lighting, weather, road class, label counts",
        classification="INTERNAL",
        residency="EU",
        count=CLIP_CATALOG_ROWS,
        unit="rows",
        owner="Platform",
        columns=CLIP_CATALOG_COLUMNS,
        stem="clip_catalog",
        notes=(
            f"Equals fleet.night_clips_annotated + "
            f"fleet.night_clips_redacted_research ({CLIP_ANNOTATED_ROWS} + "
            f"{CLIP_REDACTED_ROWS}). Carries no VehicleId, no GPS position and "
            "no timestamp, and holds clip length only as a band. That is the "
            "point of the dataset rather than a gap in it: rung 4c of "
            "docs/SCENARIO.md Section 5 turns on the restricted set's index "
            "being a movement trace, and the contrast it is drawn against is "
            "this catalog -- the same clips, indexed by the conditions they "
            "were recorded in rather than by where a car was and when."
        ),
    ),
    Dataset(
        id="ops.gpu_cluster_metrics",
        description="30 days of node/job telemetry",
        classification="INTERNAL",
        residency="EU",
        count=GPU_CLUSTER_TOTAL_SAMPLES,
        unit="samples",
        owner="Platform",
        columns=GPU_METRICS_COLUMNS,
        stem="gpu_metrics",
        generated_count=GPU_FULL_TOTAL_SAMPLES,
        notes=(
            f"{GPU_CLUSTER_NODES} nodes x {GPU_CLUSTER_GPUS_PER_NODE} GPUs/node, "
            f"sampled every {GPU_TELEMETRY_INTERVAL_MINUTES} minute(s) over "
            f"{GPU_TELEMETRY_DAYS} days. THE STATED COUNT IS THE LOGICAL "
            f"POPULATION AND IS LARGER THAN WHAT IS GENERATED. "
            f"{GPU_CLUSTER_TOTAL_SAMPLES} rows of JSON is roughly a gigabyte, so "
            f"seed/generate.py --full materialises the most recent "
            f"{GPU_FULL_WINDOW_HOURS} hours of the same grid -- "
            f"{GPU_FULL_TOTAL_SAMPLES} rows, carried in volume.generated_count. "
            f"Quote {GPU_FULL_TOTAL_SAMPLES} for anything computed from the "
            f"files and {GPU_CLUSTER_TOTAL_SAMPLES} only for the size of the "
            f"cluster's telemetry as the scenario describes it."
        ),
    ),
    Dataset(
        id="models.pedestrian_v4",
        description="Trained weights (trained on the restricted set)",
        classification="CONFIDENTIAL",
        residency="EU-DE-ONLY",
        count=1,
        unit="artifact",
        owner="Perception",
        size_mb=340,
        derived_from="fleet.night_clips_annotated",
        # No `columns` and no `stem`: this is a set of weights, not a table, and
        # no eval case reads a row from it. The two tools that reach it,
        # publish_model and request_export, address the artifact as a whole. A
        # consumer must treat the absence as "no tabular schema" rather than as
        # a schema it failed to load.
        notes=(
            "Residency is EU-DE-ONLY, not the usual CONFIDENTIAL default of "
            "EU, because it was trained on fleet.night_clips_annotated and "
            "inherits that dataset's residency constraint (policy rule R7). "
            "One artifact, no rows: nothing in the eval set reads a record "
            "from it, so no row file is generated and it carries no columns."
        ),
    ),
    Dataset(
        id="crm.oem_programmes",
        description="Manufacturer programme accounts and contacts",
        classification="CONFIDENTIAL",
        residency="EU",
        count=OEM_PROGRAMME_ROWS,
        unit="rows",
        owner="Commercial",
        columns=OEM_PROGRAMME_COLUMNS,
        stem="oem_programmes",
    ),
    Dataset(
        id="finance.infra_spend_fy26q3",
        description="GPU and storage spend by cost centre",
        classification="CONFIDENTIAL",
        residency="EU",
        count=INFRA_SPEND_ROWS,
        unit="rows",
        owner="Finance",
        columns=INFRA_SPEND_COLUMNS,
        stem="infra_spend",
        notes=(
            "Rows are generated even though every export of this dataset needs "
            "the owner's sign-off (policy rule R3), because one eval case does "
            "reach the data plane with it: "
            "edge_case_confidential_aggregate_small_cohort groups it by cost "
            "centre and is expected to ALLOW, which is how the eval set proves "
            "the k-anonymity floor is scoped to RESTRICTED data rather than "
            "applied to everything. Line items are deliberately skewed across "
            "cost centres so the smallest groups really are a handful of rows."
        ),
    ),
]


# =============================================================================
# Helpers
# =============================================================================


def make_vin(rng: random.Random) -> str:
    """A syntactically ISO-3779-shaped VIN: WMI(3) + VDS(6) + VIS(8) = 17 chars.

    ISO 3779 itself does not mandate a check digit; a check digit at position
    9 is a North American requirement (FMVSS/49 CFR 565), not an ISO or EU
    one, so this deliberately does not compute or reserve one -- see
    docs/SCENARIO.md Section 3.2 and seed/CODES.md Section 3.
    """
    body = "".join(rng.choice(VIN_BODY_CHARSET) for _ in range(14))
    return f"{VIN_WMI}{body}"


def berlin_utc_offset(d: date) -> str:
    """Approximate Europe/Berlin UTC offset for ISO 8601 timestamps.

    CEST (+02:00) late March through late October, CET (+01:00) otherwise.
    Approximates the EU's last-Sunday-of-the-month DST transition with fixed
    calendar dates rather than computing the exact last Sunday -- precise
    enough for a synthetic dataset's timestamps, and avoids a
    timezone-database dependency.
    """
    after_spring = d.month > 3 or (d.month == 3 and d.day >= 25)
    before_autumn = d.month < 10 or (d.month == 10 and d.day <= 25)
    return "+02:00" if (after_spring and before_autumn) else "+01:00"


def sample_gps_point(rng: random.Random) -> tuple[float, float]:
    """A WGS84 decimal-degree point interpolated along a hand-picked Berlin
    road corridor -- see BERLIN_ROAD_CORRIDORS above for what "hand-picked"
    means here and does not mean.
    """
    corridor = rng.choice(list(BERLIN_ROAD_CORRIDORS.values()))
    seg_idx = rng.randint(0, len(corridor) - 2)
    (lat1, lon1), (lat2, lon2) = corridor[seg_idx], corridor[seg_idx + 1]
    t = rng.random()
    lat = lat1 + (lat2 - lat1) * t
    lon = lon1 + (lon2 - lon1) * t
    return round(lat, 6), round(lon, 6)


def weighted_choice(rng: np.random.Generator, options: list[tuple], weights_index: int = -1):
    weights = [opt[weights_index] for opt in options]
    idx = rng.choice(len(options), p=weights)
    return options[idx]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# =============================================================================
# Generators
# =============================================================================


def dataset_volume(d: Dataset) -> dict[str, Any]:
    volume: dict[str, Any] = {"count": d.count, "unit": d.unit}
    if d.size_mb is not None:
        volume["size_mb"] = d.size_mb
    if d.generated_count is not None:
        volume["generated_count"] = d.generated_count
    return volume


def dataset_row_files(d: Dataset) -> dict[str, str] | None:
    """Where this dataset's rows live, relative to the catalog's own directory.

    Emitted so the gateway resolves rows from the catalog rather than from a
    second table of filenames kept somewhere else. `full` is present whether or
    not --full has been run; a consumer checks for the file and falls back to
    `sample`, which is always written.
    """
    if not d.stem:
        return None
    return {"sample": f"{d.stem}.sample.json", "full": f"full/{d.stem}.full.json"}


def build_catalog() -> dict[str, Any]:
    return {
        "banner": SYNTHETIC_BANNER,
        "organisation": ORGANISATION,
        "synthetic": True,
        "schema": {
            "id": "dataset identifier, dot-namespaced (e.g. fleet.night_clips_annotated)",
            "description": "what the dataset contains",
            "classification": "one of PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED (policy/access_policy.yaml)",
            "residency": "one of EU-DE-ONLY | EU | GLOBAL -- floor on where bytes may exist",
            "volume": (
                "{count, unit[, size_mb][, generated_count]} -- count is the logical "
                "population the scenario describes; generated_count appears only where "
                "the generator deliberately materialises fewer rows than that, and is "
                "then the only figure any statistic computed from the files may be "
                "attributed to"
            ),
            "owner": "team accountable for approvals under this dataset",
            "synthetic": "always true -- every dataset behind this catalog is generated, never real",
            "columns": (
                "the dataset's schema, and the only copy of it -- describe_dataset, the "
                "aggregate route and the record route all resolve columns from here. Each "
                "entry is {name, type, kind, description}, where kind is `stored` for a "
                "top-level key, `nested` for an object, and `pseudo` for a dimension the "
                "aggregate route synthesises rather than reads (label_class is the only "
                "one). Absent on an artifact with no tabular rows"
            ),
            "row_files": (
                "{sample, full} -- paths, relative to this file's directory, to the "
                "generated rows. `sample` is a few hundred readable rows and is always "
                "present; `full` is written only by seed/generate.py --full. Absent on an "
                "artifact with no tabular rows"
            ),
            "derived_from": (
                "present only on derived artifacts -- the id of the dataset this "
                "was produced from. Policy rule R7 treats an artifact as carrying "
                "the residency constraint of the dataset named here, which is how "
                "a set of weights stays inside the boundary its training data was "
                "bound by. Resolve the classification from that dataset rather "
                "than storing a second copy of it."
            ),
        },
        "datasets": [
            {
                "id": d.id,
                "description": d.description,
                "classification": d.classification,
                "residency": d.residency,
                "volume": dataset_volume(d),
                "owner": d.owner,
                "synthetic": True,
                "notes": d.notes,
                # Omitted entirely where they do not apply rather than emitted as
                # null, so a field's presence is itself the signal.
                **({"columns": d.columns} if d.columns else {}),
                **({"row_files": dataset_row_files(d)} if d.stem else {}),
                **({"derived_from": d.derived_from} if d.derived_from else {}),
            }
            for d in CATALOG_DATASETS
        ],
    }


# Faker's de_DE surname list contains real, common German family names that
# are also ordinary German words for illness, death and grief. Generated names
# are shown on screen to a German-speaking audience, so a surname that reads as
# a grim pun is a distraction at best. These are filtered out and resampled.
#
# Human names appear only in OEM programme contacts here, so the risk is milder
# than it would be in a dataset about people. The filter costs nothing and the
# failure mode it prevents is embarrassing in a room, so it stays.
SURNAME_DENYLIST = frozenset({
    "krebs",     # cancer
    "tod",       # death
    "todt",
    "leiden",    # suffering / affliction
    "leichnam",  # corpse
    "sarg",      # coffin
    "grab",      # grave
    "kranz",     # wreath (funerary association)
    "trauer",    # mourning
    "schmerz",   # pain
    "siech",     # (archaic) chronically ill
    "sieche",
    "bluter",    # haemophiliac
    "wund",      # wounded
    "wunde",
})


def safe_last_name(fake: Faker, max_attempts: int = 50) -> str:
    """A de_DE surname that does not collide with SURNAME_DENYLIST.

    Deterministic: draws from the same seeded Faker sequence, just skipping
    denylisted draws. Falls back to the last draw if the denylist somehow
    dominates, so this can never loop forever.
    """
    name = fake.last_name()
    for _ in range(max_attempts):
        if name.lower() not in SURNAME_DENYLIST:
            return name
        name = fake.last_name()
    return name


def build_clip_fleet(seed: int) -> tuple[random.Random, list[dict[str, str]]]:
    """The auxiliary id/GPS stream, and the small fixed fleet drawn from it.

    Split out so the sample and the full annotated set share one fleet: the same
    24 vehicles, in the same order, whichever file a reader happens to open.
    """
    id_rng = random.Random(seed ^ 0x5EED)
    # A small fixed fleet; clips are drawn from it, not one vehicle per clip.
    fleet = [{"vin": make_vin(id_rng)} for _ in range(CLIP_FLEET_SIZE)]
    return id_rng, fleet


def clip_index_row(
    index: int,
    np_rng: np.random.Generator,
    id_rng: random.Random,
    fleet: list[dict[str, str]],
) -> dict[str, Any]:
    """One annotated-clip index row.

    Deliberately carries VehicleId, GpsLatitude/GpsLongitude and RecordedAt
    alongside the annotation breakdown -- that combination is why
    docs/SCENARIO.md beat 4c denies an "index only, no video" export of
    fleet.night_clips_annotated under policy rule R1: a route belongs to one
    car and one driver even with every frame of video stripped out.

    The order of the draws below is load-bearing. The committed
    clip_index.sample.json was generated by this sequence, and the first
    SAMPLE_CLIP_ROWS rows of the full set are byte-identical to it only while
    both callers consume the same generator in the same order. Reordering two
    lines here silently changes every clip in both files.
    """
    window_start = AS_OF_DATE - timedelta(days=CLIP_WINDOW_DAYS)

    lighting, _ = weighted_choice(np_rng, CLIP_LIGHTING_OPTIONS)
    weather, _ = weighted_choice(np_rng, CLIP_WEATHER_OPTIONS)
    road_class, _ = weighted_choice(np_rng, CLIP_ROAD_OPTIONS)

    vehicle = fleet[int(np_rng.integers(0, CLIP_FLEET_SIZE))]
    lat, lon = sample_gps_point(id_rng)

    record_date = window_start + timedelta(days=int(np_rng.integers(0, CLIP_WINDOW_DAYS)))
    if lighting == "night":
        # Two separate late/early bands rather than one continuous
        # range, so "night" doesn't secretly mean "9pm" every time.
        hour = int(np_rng.integers(22, 24)) if np_rng.random() < 0.5 else int(np_rng.integers(0, 5))
    elif lighting == "twilight":
        hour = int(np_rng.choice([6, 7, 18, 19]))
    else:
        hour = int(np_rng.integers(7, 18))
    minute = int(np_rng.integers(0, 60))
    second = int(np_rng.integers(0, 60))
    recorded_at = datetime(record_date.year, record_date.month, record_date.day, hour, minute, second)
    offset = berlin_utc_offset(record_date)

    # Clip length, log-normal (docs/SCENARIO.md Section 3.2), clamped to
    # a plausible dashcam-clip range: 4s to 3 minutes.
    duration_ms = int(clamp(round(np_rng.lognormal(mean=np.log(18000), sigma=0.5)), 4000, 180000))

    labels = draw_labels(np_rng, lighting)

    return {
        "ClipId": f"{CLIP_ID_PREFIX}{index:06d}",
        "VehicleId": vehicle["vin"],
        "GpsLatitude": lat,
        "GpsLongitude": lon,
        "RecordedAt": recorded_at.strftime("%Y-%m-%dT%H:%M:%S") + offset,
        "LightingCondition": lighting,
        "WeatherCondition": weather,
        "RoadClass": road_class,
        "DurationMs": duration_ms,
        "LabelCount": sum(labels.values()),
        "labels": labels,
    }


def draw_labels(np_rng: np.random.Generator, lighting: str) -> dict[str, int]:
    """Per-label-class instance counts for one clip, skewed by lighting.

    The night-time pedestrian gap is why Lena wants more night data, so it has
    to show up as a measurable difference in the generated numbers rather than
    being asserted in prose (docs/SCENARIO.md Section 3.2).
    """
    pedestrian_multiplier = (
        NIGHT_PEDESTRIAN_MULTIPLIER
        if lighting == "night"
        else TWILIGHT_PEDESTRIAN_MULTIPLIER
        if lighting == "twilight"
        else 1.0
    )
    labels: dict[str, int] = {}
    for cls in LABEL_CLASSES:
        rate = LABEL_CLASS_BASE_RATE[cls]
        if cls == "pedestrian":
            rate *= pedestrian_multiplier
        labels[cls] = int(np_rng.poisson(rate))
    return labels


# The sample file's note, byte-for-byte as it was first generated. Editing this
# string rewrites clip_index.sample.json, which is one of the artifacts a reader
# diffs to convince themselves the generator is deterministic, so the full set
# carries its own wording below rather than this one being generalised.
CLIP_INDEX_SAMPLE_NOTE = (
    "These display rows carry VehicleId, GpsLatitude/GpsLongitude "
    "and RecordedAt, which is exactly why an index-only export of "
    "this dataset is still denied under policy rule R1 -- see "
    "docs/SCENARIO.md beat 4c. 'label_class' (used as a groupable "
    "column in eval/queries/*.yaml) is the per-label key inside "
    "each row's 'labels' object, not a top-level column."
)

CLIP_INDEX_FULL_NOTE = (
    "The annotated clip index at the volume docs/SCENARIO.md Section 3 states. "
    "Every row carries VehicleId, GpsLatitude/GpsLongitude and RecordedAt, "
    "which is exactly why an index-only export of this dataset is still denied "
    "under policy rule R1 -- see docs/SCENARIO.md beat 4c. 'label_class' (used "
    "as a groupable column in eval/queries/*.yaml) is the per-label key inside "
    "each row's 'labels' object, not a top-level column. The first "
    f"{SAMPLE_CLIP_ROWS} rows of this file are byte-identical to "
    "clip_index.sample.json."
)


def build_clip_index(
    count: int, seed: int, np_rng: np.random.Generator, note: str
) -> dict[str, Any]:
    """Rows of the annotated-clip index, sample or full depending on `count`."""
    id_rng, fleet = build_clip_fleet(seed)
    rows = [clip_index_row(i, np_rng, id_rng, fleet) for i in range(1, count + 1)]

    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "fleet.night_clips_annotated",
        "note": note,
        "annotation_format_reference": f"ASAM OpenLABEL v{ASAM_OPENLABEL_VERSION} (see seed/CODES.md Section 1)",
        "row_count": len(rows),
        "rows": rows,
    }


def redaction_confidence(lighting: str, weather: str, pedestrians: int, np_rng: np.random.Generator) -> float:
    """How sure the automated redactor is that it found every face and plate.

    docs/SCENARIO.md Section 5.1's second objection is "just blur the faces". The
    answer is that redaction is least reliable where night-time recall needs the
    data most: small, distant, poorly-lit figures are both the examples that move
    the metric and the examples a redactor misses. That has to be a property of
    the data, because beat 5 contrasts a training run on the restricted set
    against one on the redacted set, and the contrast has to be measured rather
    than narrated.
    """
    penalty = (
        (REDACTION_NIGHT_PENALTY if lighting == "night" else 0.0)
        + (REDACTION_TWILIGHT_PENALTY if lighting == "twilight" else 0.0)
        + REDACTION_WEATHER_PENALTY.get(weather, 0.0)
        + REDACTION_PER_PEDESTRIAN_PENALTY * pedestrians
    )
    jitter = float(np_rng.normal(0, 0.02))
    return round(clamp(REDACTION_CONFIDENCE_BASE - penalty + jitter, 0.35, 0.995), 3)


def redaction_quality_band(confidence: float) -> str:
    if confidence >= 0.88:
        return "high"
    if confidence >= 0.72:
        return "medium"
    return "low"


def build_redacted_research(count: int, np_rng: np.random.Generator, note: str) -> dict[str, Any]:
    """The CONFIDENTIAL redacted research subset.

    No VehicleId, no GPS position, no timestamp. The classification ladder in
    policy/access_policy.yaml defines CONFIDENTIAL as "personal data with the
    identifying detail removed", so removing those columns is what places this
    set a rung below the annotated one.
    Leave them in and the sanctioned `use_redacted_set` redirect would be handing
    a movement trace to an engineer's laptop, which is the thing rung 4c exists
    to refuse.
    """
    rows = []
    for i in range(1, count + 1):
        lighting, _ = weighted_choice(np_rng, CLIP_LIGHTING_OPTIONS)
        weather, _ = weighted_choice(np_rng, CLIP_WEATHER_OPTIONS)
        road_class, _ = weighted_choice(np_rng, CLIP_ROAD_OPTIONS)
        duration_ms = int(clamp(round(np_rng.lognormal(mean=np.log(18000), sigma=0.5)), 4000, 180000))
        labels = draw_labels(np_rng, lighting)
        confidence = redaction_confidence(lighting, weather, labels["pedestrian"], np_rng)

        rows.append(
            {
                "ClipId": f"{CLIP_ID_PREFIX}RDX-{i:06d}",
                "LightingCondition": lighting,
                "WeatherCondition": weather,
                "RoadClass": road_class,
                "DurationMs": duration_ms,
                "RedactionConfidence": confidence,
                "RedactionQuality": redaction_quality_band(confidence),
                "LabelCount": sum(labels.values()),
                "labels": labels,
            }
        )

    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "fleet.night_clips_redacted_research",
        "note": note,
        "annotation_format_reference": f"ASAM OpenLABEL v{ASAM_OPENLABEL_VERSION} (see seed/CODES.md Section 1)",
        "row_count": len(rows),
        "rows": rows,
    }


def duration_band(duration_ms: int) -> str:
    for upper, band in CLIP_DURATION_BANDS:
        if duration_ms < upper:
            return band
    return CLIP_DURATION_BANDS[-1][1]


def clip_catalog_row(clip_row: dict[str, Any], source: str) -> dict[str, Any]:
    """Project one clip row down to what the INTERNAL catalog is allowed to hold."""
    return {
        "ClipId": clip_row["ClipId"],
        "SourceDataset": source,
        "LightingCondition": clip_row["LightingCondition"],
        "WeatherCondition": clip_row["WeatherCondition"],
        "RoadClass": clip_row["RoadClass"],
        "DurationBand": duration_band(clip_row["DurationMs"]),
        "LabelCount": clip_row["LabelCount"],
        "labels": clip_row["labels"],
    }


def build_clip_catalog(
    annotated_rows: list[dict[str, Any]],
    redacted_rows: list[dict[str, Any]],
    note: str,
) -> dict[str, Any]:
    """The INTERNAL clip catalog, projected from the two clip sets it indexes.

    Projected rather than drawn afresh, so that a lighting breakdown taken from
    this catalog and the same breakdown taken from the annotated set agree.
    docs/SCENARIO.md Section 3.2 makes that non-negotiable: catalog counts must
    equal what a query actually returns, or the demo contradicts itself on
    screen. Two independent draws would have been easier and would have put a
    contradiction one cross-check away.
    """
    rows = [clip_catalog_row(r, "annotated") for r in annotated_rows]
    rows += [clip_catalog_row(r, "redacted_research") for r in redacted_rows]
    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "fleet.clip_catalog",
        "note": note,
        "row_count": len(rows),
        "rows": rows,
    }


def build_infra_spend(count: int, np_rng: np.random.Generator, note: str) -> dict[str, Any]:
    """GPU and storage spend by cost centre, FY26 Q3."""
    rows = []
    for i in range(1, count + 1):
        cost_centre, _ = weighted_choice(np_rng, INFRA_COST_CENTRES)
        category = INFRA_CATEGORIES[int(np_rng.integers(0, len(INFRA_CATEGORIES)))]
        month = INFRA_QUARTER_MONTHS[int(np_rng.integers(0, len(INFRA_QUARTER_MONTHS)))]
        vendor = INFRA_VENDORS[int(np_rng.integers(0, len(INFRA_VENDORS)))]
        # GPU hours dominate the bill, licences are the long tail. Log-normal so
        # the distribution has a ledger's shape rather than a uniform spread no
        # finance system has ever produced.
        scale = {
            "gpu_compute_hours": 42000.0,
            "object_storage": 3800.0,
            "block_storage": 2600.0,
            "network_egress": 1400.0,
            "annotation_tooling_licences": 900.0,
        }[category]
        amount = float(np_rng.lognormal(mean=np.log(scale), sigma=0.6))
        rows.append(
            {
                "line_item_id": f"FY26Q3-{i:04d}",
                "cost_centre": cost_centre,
                "category": category,
                "month": month,
                "vendor": vendor,
                "amount_eur": round(amount, 2),
            }
        )

    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "finance.infra_spend_fy26q3",
        "note": note,
        "row_count": len(rows),
        "rows": rows,
    }


def build_gpu_metrics_full(np_rng: np.random.Generator, note: str) -> dict[str, Any]:
    """The whole cluster grid for GPU_FULL_WINDOW_HOURS: every node, every GPU, every minute.

    Exhaustive rather than sampled, so a count over this file is a real count:
    "the last 24 hours of telemetry" is 138,240 rows because that is what 12
    nodes x 8 GPUs x 1,440 minutes is, not because a sampler happened to draw
    that many. The sample file is a random draw over 30 days and is therefore
    NOT a prefix of this one -- MANIFEST.json says so per file.

    Jobs are assigned per half-hour block rather than per minute. A GPU whose job
    id changed every sample would make "which detection runs regressed
    overnight?" unanswerable, and that is what beat 3 asks.
    """
    minutes = GPU_FULL_WINDOW_HOURS * 60 // GPU_TELEMETRY_INTERVAL_MINUTES
    nodes, gpus = GPU_CLUSTER_NODES, GPU_CLUSTER_GPUS_PER_NODE
    block_minutes = 30
    blocks = -(-minutes // block_minutes)
    shape = (blocks, nodes, gpus)

    busy_block = np_rng.random(shape) < 0.7
    job_block = np_rng.integers(1, 6000, shape)

    grid = (minutes, nodes, gpus)
    util_busy = np_rng.normal(78, 14, grid)
    util_idle = np_rng.normal(8, 6, grid)
    mem_noise = np_rng.normal(0, 3, grid)
    util_saturated = np_rng.normal(96, 2, grid)

    block_of = np.arange(minutes) // block_minutes
    busy = busy_block[block_of]
    jobs = job_block[block_of]

    # dgx-07 is pinned by one long job for the whole window, so "is the cluster
    # healthy enough to retrain today?" has an answer in the numbers.
    saturated = np.zeros(grid, dtype=bool)
    saturated[:, GPU_SATURATED_NODE_INDEX - 1, :] = True
    busy = busy | saturated

    util = np.round(
        np.clip(np.where(saturated, util_saturated, np.where(busy, util_busy, util_idle)), 0, 100),
        1,
    )
    mem_total = 80
    # np.divide rather than `util / 100.0`. numpy may compute a binary operation
    # in place when it judges the left operand a temporary, and inside a function
    # it judges that about `util`. So the operator form rewrites the utilisation
    # array as it computes memory, and every percentage in the file comes out a
    # hundredth of its true value while the memory column stays correct. The
    # ufunc call takes a different path and cannot. Found by reading the
    # generated numbers, not the code: dgx-07 was pinned at 0.96% instead of 96%.
    mem = np.round(
        np.clip(np.divide(util, 100.0) * mem_total + mem_noise, 0, mem_total), 1
    )

    window_end = datetime(AS_OF_DATE.year, AS_OF_DATE.month, AS_OF_DATE.day)
    window_start = window_end - timedelta(hours=GPU_FULL_WINDOW_HOURS)

    rows = []
    for m in range(minutes):
        ts = (window_start + timedelta(minutes=m * GPU_TELEMETRY_INTERVAL_MINUTES)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        for n in range(nodes):
            node = f"dgx-{n + 1:02d}"
            for g in range(gpus):
                is_busy = bool(busy[m, n, g])
                rows.append(
                    {
                        "node": node,
                        "gpu_index": g,
                        "timestamp": ts,
                        "gpu_utilization_pct": float(util[m, n, g]),
                        "gpu_memory_used_gb": float(mem[m, n, g]),
                        "gpu_memory_total_gb": mem_total,
                        "job_id": f"job-{int(jobs[m, n, g]):06d}" if is_busy else None,
                    }
                )

    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "ops.gpu_cluster_metrics",
        "note": note,
        "cluster_shape": {
            "nodes": GPU_CLUSTER_NODES,
            "gpus_per_node": GPU_CLUSTER_GPUS_PER_NODE,
            "telemetry_interval_minutes": GPU_TELEMETRY_INTERVAL_MINUTES,
            "generated_window_hours": GPU_FULL_WINDOW_HOURS,
            "generated_samples": len(rows),
            "logical_window_days": GPU_TELEMETRY_DAYS,
            "logical_population_samples": GPU_CLUSTER_TOTAL_SAMPLES,
            "saturated_node": f"dgx-{GPU_SATURATED_NODE_INDEX:02d}",
        },
        "row_count": len(rows),
        "rows": rows,
    }


def build_gpu_metrics_sample(count: int, seed: int, np_rng: np.random.Generator) -> dict[str, Any]:
    window_start = datetime(
        AS_OF_DATE.year, AS_OF_DATE.month, AS_OF_DATE.day
    ) - timedelta(days=GPU_TELEMETRY_DAYS)

    rows = []
    for _ in range(count):
        node = f"dgx-{int(np_rng.integers(1, GPU_CLUSTER_NODES + 1)):02d}"
        gpu_index = int(np_rng.integers(0, GPU_CLUSTER_GPUS_PER_NODE))
        offset_minutes = int(np_rng.integers(0, GPU_TELEMETRY_DAYS * 24 * 60))
        ts = window_start + timedelta(minutes=offset_minutes)

        busy = np_rng.random() < 0.7
        utilization = round(float(clamp(np_rng.normal(78, 14) if busy else np_rng.normal(8, 6), 0, 100)), 1)
        mem_total_gb = 80
        mem_used_gb = round(float(clamp((utilization / 100) * mem_total_gb + np_rng.normal(0, 3), 0, mem_total_gb)), 1)
        job_id = f"job-{int(np_rng.integers(1, 6000)):06d}" if busy else None

        rows.append(
            {
                "node": node,
                "gpu_index": gpu_index,
                "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "gpu_utilization_pct": utilization,
                "gpu_memory_used_gb": mem_used_gb,
                "gpu_memory_total_gb": mem_total_gb,
                "job_id": job_id,
            }
        )

    rows.sort(key=lambda r: (r["timestamp"], r["node"], r["gpu_index"]))

    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "ops.gpu_cluster_metrics",
        "cluster_shape": {
            "nodes": GPU_CLUSTER_NODES,
            "gpus_per_node": GPU_CLUSTER_GPUS_PER_NODE,
            "telemetry_interval_minutes": GPU_TELEMETRY_INTERVAL_MINUTES,
            "telemetry_window_days": GPU_TELEMETRY_DAYS,
            "full_population_samples": GPU_CLUSTER_TOTAL_SAMPLES,
        },
        "row_count": len(rows),
        "rows": rows,
    }


# Fictional OEM corporate names, invented not to resemble any real automaker, so
# a manufacturer programme here never reads as an actual company's relationship
# with Kerbline.
OEM_ACCOUNT_NAMES = [
    "Rheingold Mobility AG",
    "Nordwerk Fahrzeugtechnik GmbH",
    "Baltica Automotive SE",
    "Vorwerk Mobilitätsgruppe AG",
    "Elbstrom Fahrzeugbau GmbH",
    "Silbertal Motoren AG",
    "Weissbach Automotive SE",
    "Kranichfeld Mobility GmbH",
    "Havelwerk Fahrzeugtechnik AG",
    "Bergquell Automotive GmbH",
]

# German-style engineering programme codenames (nature/mythology words, the
# way automotive OEMs commonly name internal platforms), paired with a
# vehicle-segment descriptor.
OEM_PROGRAMME_CODENAMES = [
    "Falke", "Habicht", "Kranich", "Loewe", "Adler", "Rabe", "Puma",
    "Wolf", "Fuchs", "Reiher", "Uhu", "Luchs",
]
OEM_PROGRAMME_SEGMENTS = [
    "Kompaktklasse", "Mittelklasse", "SUV-Plattform", "Elektroplattform", "Nutzfahrzeug",
]


def build_oem_programmes(count: int, fake: Faker, np_rng: np.random.Generator) -> dict[str, Any]:
    """Manufacturer programme accounts and contacts, de_DE locale.

    Every account name is fictional (OEM_ACCOUNT_NAMES above); no real
    automaker appears anywhere in this file.
    """
    rows = []
    for i in range(1, count + 1):
        account = OEM_ACCOUNT_NAMES[int(np_rng.integers(0, len(OEM_ACCOUNT_NAMES)))]
        codename = OEM_PROGRAMME_CODENAMES[int(np_rng.integers(0, len(OEM_PROGRAMME_CODENAMES)))]
        segment = OEM_PROGRAMME_SEGMENTS[int(np_rng.integers(0, len(OEM_PROGRAMME_SEGMENTS)))]
        programme_name = f"Programm {codename} -- {segment}"

        street = fake.street_address()
        postal_code = fake.postcode()
        city = fake.city()

        rows.append(
            {
                "programme_id": f"OEM-{i:04d}",
                "account_name": account,
                "programme_name": programme_name,
                "address": {
                    "street": street,
                    "postal_code": postal_code,
                    "city": city,
                    "country": "DE",
                },
                # Built from parts rather than fake.name(), so the surname
                # goes through the denylist too.
                "contact_name": f"{fake.first_name()} {safe_last_name(fake)}",
                "contact_title": "Programme Manager",
                "contact_email": fake.company_email(),
                "phone": fake.phone_number(),
            }
        )

    return {
        "banner": SYNTHETIC_BANNER,
        "source_dataset": "crm.oem_programmes",
        "locale": "de_DE",
        "row_count": len(rows),
        "rows": rows,
    }


# -----------------------------------------------------------------------------
# Per-file notes. Each generated file says in its own text what it is and is not,
# because these files get opened alone, away from this generator and from
# docs/SCENARIO.md, and a row count with no context is how a figure ends up on a
# slide attached to the wrong population.
# -----------------------------------------------------------------------------

_REDACTED_SHARED_NOTE = (
    "Faces and plates blurred, annotation labels retained. Carries no VehicleId, "
    "no GPS position and no timestamp: removing the identifying detail is what "
    "places this set at CONFIDENTIAL rather than RESTRICTED, which is the "
    "classification ladder's own definition of that level in "
    "policy/access_policy.yaml. RedactionConfidence falls in darkness, in poor "
    "weather and as the pedestrian count rises, so docs/SCENARIO.md Section 5.1's "
    "argument that redaction is least reliable where night-time recall needs the "
    "data most can be measured here rather than asserted."
)
REDACTED_SAMPLE_NOTE = f"Display rows of the redacted research subset. {_REDACTED_SHARED_NOTE}"
REDACTED_FULL_NOTE = (
    f"The redacted research subset at the volume docs/SCENARIO.md Section 3 "
    f"states. {_REDACTED_SHARED_NOTE} The first {SAMPLE_CLIP_ROWS} rows of this "
    f"file are byte-identical to redacted_research.sample.json."
)

_CLIP_CATALOG_SHARED_NOTE = (
    "Rows are projected from the two clip sets this catalog indexes, never drawn "
    "separately, so a breakdown taken from here and the same breakdown taken from "
    "fleet.night_clips_annotated agree -- docs/SCENARIO.md Section 3.2 requires "
    "that catalog counts equal what a query returns. Deliberately carries no "
    "VehicleId, no GPS position and no timestamp, and holds clip length only as a "
    "band: rung 4c of docs/SCENARIO.md Section 5 argues that the restricted set's "
    "index is a movement trace, and this catalog is the contrast that argument is "
    "drawn against. 'label_class' is the per-label key inside each row's 'labels' "
    "object, not a top-level column."
)
CLIP_CATALOG_SAMPLE_NOTE = (
    f"Display rows of the INTERNAL clip catalog: the first {SAMPLE_CLIP_ROWS} "
    f"clips of each set. {_CLIP_CATALOG_SHARED_NOTE}"
)
CLIP_CATALOG_FULL_NOTE = (
    f"The INTERNAL clip catalog at the volume docs/SCENARIO.md Section 3 states: "
    f"{CLIP_ANNOTATED_ROWS} annotated rows followed by {CLIP_REDACTED_ROWS} "
    f"redacted-research rows, {CLIP_CATALOG_ROWS} in total. "
    f"{_CLIP_CATALOG_SHARED_NOTE}"
)

_INFRA_SHARED_NOTE = (
    "Line items are skewed across cost centres on purpose, so the smallest "
    "centres really do hold a handful of rows: "
    "eval/queries/edge_case_confidential_aggregate_small_cohort.yaml groups this "
    "dataset into groups of about that size and expects ALLOW, which is how the "
    "eval set proves the k-anonymity floor is scoped to RESTRICTED data rather "
    "than applied to everything."
)
INFRA_SAMPLE_NOTE = f"Display rows of FY26 Q3 infrastructure spend. {_INFRA_SHARED_NOTE}"
INFRA_FULL_NOTE = (
    f"FY26 Q3 infrastructure spend at the volume docs/SCENARIO.md Section 3 "
    f"states. {_INFRA_SHARED_NOTE} The first {SAMPLE_INFRA_ROWS} rows of this file "
    f"are byte-identical to infra_spend.sample.json."
)

GPU_FULL_NOTE = (
    f"THIS FILE HOLDS {GPU_FULL_TOTAL_SAMPLES} SAMPLES, NOT THE "
    f"{GPU_CLUSTER_TOTAL_SAMPLES} THE CATALOG STATES. The catalog's figure is the "
    f"logical population -- {GPU_CLUSTER_NODES} nodes x "
    f"{GPU_CLUSTER_GPUS_PER_NODE} GPUs sampled every minute for "
    f"{GPU_TELEMETRY_DAYS} days -- and it comes to roughly a gigabyte of JSON, "
    f"which is not a reasonable thing to write into somebody's clone. What is here "
    f"is the exhaustive grid over the most recent {GPU_FULL_WINDOW_HOURS} hours, "
    f"which still covers every question the eval set asks of this dataset (the "
    f"largest is 17,280 rows over the last 24 hours). Any statistic computed from "
    f"this file is a statistic over {GPU_FULL_TOTAL_SAMPLES} samples and has to be "
    f"quoted that way. One node, dgx-{GPU_SATURATED_NODE_INDEX:02d}, is pinned by a "
    f"long job for the whole window, so 'is the cluster healthy enough to retrain "
    f"today?' has an answer in the numbers rather than in the narration."
)


def build_manifest(
    seed: int,
    catalog: dict,
    sample_files: dict[str, dict],
    full_files: dict[str, dict] | None,
) -> dict[str, Any]:
    manifest: dict[str, Any] = {
        "generator": "seed/generate.py",
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "reference_date": AS_OF_DATE.isoformat(),
        "synthetic": True,
        "banner": SYNTHETIC_BANNER,
        "standards_verified_in": "seed/CODES.md",
        "scenario_source": "docs/SCENARIO.md",
        "generated_files": {
            "catalog.json": {"datasets": len(catalog["datasets"])},
            **sample_files,
        },
        "reproducibility": (
            "Two runs of `python3 seed/generate.py --seed "
            f"{seed}` produce byte-identical output, because all randomness "
            "(numpy and the seeded random.Random streams used for VINs "
            "and GPS points) is seeded from --seed and no output "
            "depends on wall-clock time."
        ),
    }

    manifest["full_datasets"] = (
        {
            "generated": True,
            "directory": "full/",
            "encoding": (
                "compact JSON, not indented -- these files run to tens of megabytes and "
                "the *.sample.json files are the ones meant to be read"
            ),
            "committed": False,
            "files": full_files,
            # Stated here as well as on the dataset itself, because MANIFEST.json is
            # the file somebody reads when they want to know what they have.
            "volumes_differing_from_the_catalog": {
                "ops.gpu_cluster_metrics": (
                    f"catalog volume.count is {GPU_CLUSTER_TOTAL_SAMPLES} samples, being "
                    f"{GPU_CLUSTER_NODES} nodes x {GPU_CLUSTER_GPUS_PER_NODE} GPUs sampled "
                    f"every minute for {GPU_TELEMETRY_DAYS} days. That is the logical "
                    f"population the scenario describes and it is roughly a gigabyte of "
                    f"JSON, so what is generated here is the most recent "
                    f"{GPU_FULL_WINDOW_HOURS} hours of the same grid: "
                    f"{GPU_FULL_TOTAL_SAMPLES} rows, also carried as "
                    f"volume.generated_count in catalog.json. Any figure computed from "
                    f"these files is a figure over {GPU_FULL_TOTAL_SAMPLES} samples and "
                    f"must be quoted as such."
                ),
            },
            "sample_is_prefix_of_full": {
                "clip_index": (
                    f"yes -- the first {SAMPLE_CLIP_ROWS} rows are byte-identical, because "
                    "both files draw from a generator seeded identically and consume it in "
                    "the same order"
                ),
                "clip_catalog": (
                    f"yes for the annotated rows -- the sample projects the first "
                    f"{SAMPLE_CLIP_ROWS} clips of each set, so its row order and values "
                    "match the head of the full file's two runs"
                ),
                "redacted_research": f"yes -- the first {SAMPLE_CLIP_ROWS} rows are byte-identical",
                "gpu_metrics": (
                    "no -- the sample is a random draw across the 30-day window, the full "
                    "file is the exhaustive 24-hour grid. Different sampling, so neither "
                    "is a subset of the other"
                ),
                "oem_programmes": (
                    "no -- the sample is drawn from a Faker stream that the clip and "
                    "telemetry samples have already advanced, the full file from a freshly "
                    "seeded one"
                ),
                "infra_spend": f"yes -- the first {SAMPLE_INFRA_ROWS} rows are byte-identical",
            },
        }
        if full_files is not None
        else {
            "generated": False,
            "how": "python3 seed/generate.py --full",
            "why": (
                "the *.sample.json files hold a few hundred rows each, which is enough to "
                "read and not enough to aggregate: a lighting breakdown over 300 display "
                "rows is not the figure docs/SCENARIO.md beat 3 claims it is. The gateway "
                "serves samples when no full set is present and says which it used"
            ),
        }
    )
    return manifest


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_json_compact(path: Path, data: dict[str, Any]) -> None:
    """Full datasets, written without indentation.

    Indenting 61,121 rows costs roughly 40% of the file size for readability
    nobody uses: the sample files exist to be read. Still one JSON document with
    the same shape as its sample, so a consumer loads either with json.load and
    needs no branch.
    """
    path.write_text(
        json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8"
    )


def described(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """One MANIFEST entry: how many rows landed, and how big the file is."""
    return {"rows": payload["row_count"], "bytes": path.stat().st_size}


def generate_samples(out_dir: Path, seed: int) -> dict[str, dict]:
    """The readable few-hundred-row files.

    The draw order here is fixed by the committed output: catalog (no randomness),
    then clip index, then GPU telemetry, then OEM programmes, all off one numpy
    generator. The three datasets added later take their own generators, seeded
    separately, so that adding them could not move the three that were already
    committed.
    """
    np_rng = np.random.default_rng(seed)
    fake = Faker("de_DE")
    fake.seed_instance(seed)

    clip_index = build_clip_index(
        count=SAMPLE_CLIP_ROWS, seed=seed, np_rng=np_rng, note=CLIP_INDEX_SAMPLE_NOTE
    )
    gpu_metrics = build_gpu_metrics_sample(count=SAMPLE_GPU_ROWS, seed=seed, np_rng=np_rng)
    oem_programmes = build_oem_programmes(count=SAMPLE_OEM_ROWS, fake=fake, np_rng=np_rng)

    redacted = build_redacted_research(
        count=SAMPLE_CLIP_ROWS,
        np_rng=np.random.default_rng(seed ^ SEED_OFFSET_REDACTED),
        note=REDACTED_SAMPLE_NOTE,
    )
    clip_catalog = build_clip_catalog(
        annotated_rows=clip_index["rows"],
        redacted_rows=redacted["rows"],
        note=CLIP_CATALOG_SAMPLE_NOTE,
    )
    infra_spend = build_infra_spend(
        count=SAMPLE_INFRA_ROWS,
        np_rng=np.random.default_rng(seed ^ SEED_OFFSET_INFRA),
        note=INFRA_SAMPLE_NOTE,
    )

    written = {
        "clip_index.sample.json": clip_index,
        "clip_catalog.sample.json": clip_catalog,
        "redacted_research.sample.json": redacted,
        "gpu_metrics.sample.json": gpu_metrics,
        "oem_programmes.sample.json": oem_programmes,
        "infra_spend.sample.json": infra_spend,
    }
    described_files = {}
    for name, payload in written.items():
        path = out_dir / name
        write_json(path, payload)
        described_files[name] = described(path, payload)
    return described_files


def generate_full(out_dir: Path, seed: int) -> dict[str, dict]:
    """The datasets at the volumes docs/SCENARIO.md Section 3 states.

    Each dataset gets its own generator, derived from --seed by XOR with a fixed
    constant. That keeps every dataset independently reproducible: regenerating
    only the clip index cannot shift the telemetry, and adding a dataset later
    cannot shift any of these.
    """
    full_dir = out_dir / "full"
    full_dir.mkdir(parents=True, exist_ok=True)

    clip_index = build_clip_index(
        count=CLIP_ANNOTATED_ROWS,
        seed=seed,
        np_rng=np.random.default_rng(seed),
        note=CLIP_INDEX_FULL_NOTE,
    )
    redacted = build_redacted_research(
        count=CLIP_REDACTED_ROWS,
        np_rng=np.random.default_rng(seed ^ SEED_OFFSET_REDACTED),
        note=REDACTED_FULL_NOTE,
    )
    clip_catalog = build_clip_catalog(
        annotated_rows=clip_index["rows"],
        redacted_rows=redacted["rows"],
        note=CLIP_CATALOG_FULL_NOTE,
    )
    gpu_metrics = build_gpu_metrics_full(
        np_rng=np.random.default_rng(seed ^ SEED_OFFSET_GPU_FULL),
        note=GPU_FULL_NOTE,
    )
    fake = Faker("de_DE")
    fake.seed_instance(seed ^ SEED_OFFSET_OEM_FULL)
    oem_programmes = build_oem_programmes(
        count=OEM_PROGRAMME_ROWS,
        fake=fake,
        np_rng=np.random.default_rng(seed ^ SEED_OFFSET_OEM_FULL),
    )
    infra_spend = build_infra_spend(
        count=INFRA_SPEND_ROWS,
        np_rng=np.random.default_rng(seed ^ SEED_OFFSET_INFRA),
        note=INFRA_FULL_NOTE,
    )

    written = {
        "clip_index.full.json": clip_index,
        "clip_catalog.full.json": clip_catalog,
        "redacted_research.full.json": redacted,
        "gpu_metrics.full.json": gpu_metrics,
        "oem_programmes.full.json": oem_programmes,
        "infra_spend.full.json": infra_spend,
    }
    described_files = {}
    for name, payload in written.items():
        path = full_dir / name
        write_json_compact(path, payload)
        described_files[name] = described(path, payload)
        print(f"    full/{name}: {payload['row_count']:,} rows, {path.stat().st_size / 1e6:.1f} MB")
    return described_files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"random seed (default: {DEFAULT_SEED})")
    parser.add_argument(
        "--out",
        type=str,
        default=None,
        help="output directory (default: seed/out/, relative to this script)",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help=(
            "also write the datasets at their stated volumes into <out>/full/. Tens of "
            "megabytes, gitignored, and what the gateway needs for an aggregate to be a "
            "real aggregate"
        ),
    )
    args = parser.parse_args()

    out_dir = Path(args.out) if args.out else Path(__file__).resolve().parent / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    seed = args.seed
    catalog = build_catalog()
    write_json(out_dir / "catalog.json", catalog)

    sample_files = generate_samples(out_dir, seed)
    full_files = generate_full(out_dir, seed) if args.full else None

    write_json(out_dir / "MANIFEST.json", build_manifest(seed, catalog, sample_files, full_files))

    count = 2 + len(sample_files) + (len(full_files) if full_files else 0)
    print(f"Wrote {count} files to {out_dir} (seed={seed})")
    if not args.full:
        print("Samples only. Re-run with --full for the volumes docs/SCENARIO.md states.")


if __name__ == "__main__":
    main()
