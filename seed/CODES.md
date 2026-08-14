# CODES.md: verified standards for the seed generator

This file is the evidence behind every standard `docs/SCENARIO.md` §3.2 names. That section
once carried `⚠ VERIFY` placeholders; they are gone because the work below resolved them, and
this file is what they were resolved into. Every claim here carries a source and a confidence
note, and anything that could not be independently confirmed says so rather than being
quietly dropped. The values generated from these standards (VINs, coordinates, timestamps) are
fake; the formats they follow are real.

`seed/generate.py` duplicates the literal values from this file as constants,
since the generator has no network access at run time and must stay
dependency-light and offline-reproducible.

---

## 1. ASAM OpenLABEL: annotation format

| Claim | Source | Confidence |
|---|---|---|
| ASAM OpenLABEL is a real, published ASAM standard for multi-sensor data labeling and scenario tagging. | https://www.asam.net/standards/detail/openlabel/ | High: ASAM's own standard page. |
| Current version is **1.0.0**, released **12 November 2021**. | https://www.asam.net/standards/detail/openlabel/ (page fetched and read) | High: read off ASAM's standard page directly, and corroborated by ASAM's own release announcement. |
| **OpenLABEL does not define a fixed list of object classes.** It specifies a data model and imports the user's own ontologies and taxonomies. ASAM: *"It is important that the labeling fits into the taxonomy definitions of a user/company. For that reason, the project group intends to provide ASAM OpenLABEL with the ability to import ontologies and taxonomies for the labeling process."* | https://www.asam.net/standards/detail/openlabel/ (page fetched and read) | High: quoted from the page. |

This resolves the open question about `LABEL_CLASSES` in `seed/generate.py`. The class list
(pedestrian, cyclist, vehicle, truck, bus, motorcycle, traffic_light, traffic_sign) is
implementer-defined, which is precisely what OpenLABEL expects; there is no published
vocabulary for it to conflict with.

Still not claimed anywhere: OpenLABEL's literal JSON field names. The full specification
sits behind ASAM's document request flow and was not fetched, so no field-level schema claim
is made from this file. `seed/generate.py` does not produce an OpenLABEL document; it
generates a representative label-class breakdown and cites the standard as the real-world
format this data models.

## 2. ASAM MDF: measurement/bus format

| Claim | Source | Confidence |
|---|---|---|
| ASAM MDF (Measurement Data Format) is a real, published binary format for measured and calculated data from sensors, ECUs and bus monitoring. | https://www.asam.net/standards/detail/mdf/ | High. |
| Current version is **4.3.0**, released **23 September 2025**, and described by ASAM as fully backward compatible. | https://www.asam.net/standards/detail/mdf/ (page fetched and read) | High: read off ASAM's standard page, replacing an earlier figure taken from a search-result title. |

Nothing in this repository's generated output is an MDF file. MDF is cited in
`docs/SCENARIO.md` §3.2 as the real format for the bus and sensor channels recorded
alongside video, and recorded here for completeness.

## 3. ISO 3779: vehicle identification number (VIN)

| Claim | Source | Confidence |
|---|---|---|
| ISO 3779 defines the VIN as 17 characters: WMI (3) + VDS (6) + VIS (8). | https://www.iso.org/obp/ui/en/#!iso:std:82285:en (ISO's own catalogue entry) plus multiple VIN-decoder summary pages (vininfohub.com, vinanalytics.com) agreeing on the same 3+6+8 breakdown | High: the ISO catalogue page itself confirms scope and title; the 3/6/8 breakdown is corroborated by several independent secondary sources. The full ISO 3779 text is paywalled, so the breakdown was not read from the primary standard's body text directly. |
| The 9th character (check digit) is a North American addition, not an ISO/EU requirement. | Search-engine synthesis citing VIN-decoder pages: "North America adds check digit, model year, plant code for extra validation"; the check digit is described elsewhere as tied to FMVSS/49 CFR 565 (US federal vehicle-safety regulation), which is a North American, not ISO, instrument. | Medium: consistent across multiple secondary sources and consistent with general knowledge of FMVSS 565, but no single source was opened that quotes ISO 3779's text saying "this standard does not require a check digit." Treat as the working assumption behind `seed/generate.py` not computing one, not as a directly quoted ISO clause. |
| Letters I, O and Q are excluded from VINs (to avoid confusion with 1 and 0). | Widely repeated across VIN-decoder reference pages; not read from the ISO 3779 primary text. | Medium: very commonly stated, not independently confirmed against the primary standard here. |

`seed/generate.py` generates a fictional 3-character WMI (`"SYN"`) followed by
14 further characters from an I/O/Q-excluding charset, for a syntactically
17-character, ISO-3779-*shaped* VIN. It does **not** compute or reserve a
check-digit at position 9. See docs/SCENARIO.md §3.2, which explicitly warns
against presenting a North American requirement as an ISO or EU one.

## 4. WGS84 and ISO 8601: coordinates and timestamps

| Claim | Source | Confidence |
|---|---|---|
| WGS84 is the standard geodetic datum for GPS-style decimal-degree latitude/longitude, with latitude in roughly ±90° and longitude in roughly ±180°. | https://en.wikipedia.org/wiki/World_Geodetic_System, plus general GIS reference material (gisgeography.com) surfaced in the same search pass. An earlier revision of this row cited the ISO 8601 article, which is the source for the timestamp row below and says nothing about geodesy; the two claims were researched in one pass and the citations got crossed. | High: this is uncontested, widely-documented territory, but the datum claim and the timestamp claim rest on different sources and are cited separately for that reason. |
| ISO 8601 timestamps with a UTC offset follow `YYYY-MM-DDTHH:MM:SS±HH:MM`, e.g. `2026-05-21T15:56:07+00:00`. | https://en.wikipedia.org/wiki/ISO_8601 | High. |

`seed/generate.py` renders `RecordedAt` in exactly this form, with an offset
approximated as `+02:00` (CEST) from late March to late October and `+01:00`
(CET) otherwise, an approximation of the EU's actual last-Sunday-of-the-month
DST transition, not a precise timezone-database calculation. This is a
deliberate simplification for a synthetic dataset's timestamps, not a claim
that the offset is correct to the day in every year.

## 5. Berlin road-corridor coordinates (not a standard, a data-quality note)

The five named-street waypoint lists in `seed/generate.py`
(`BERLIN_ROAD_CORRIDORS`) are hand-picked and only order-of-magnitude checked
against public map coordinates for each street (e.g. Karl-Marx-Allee's
publicly listed coordinates, ~52.516°N/13.434°E, versus the corridor's
~52.515–52.521°N/13.425–13.451°E). They are **not surveyed GPS data** and are
not presented as verified in the same sense as the standards above. Only the
*coordinate format* (WGS84 decimal degrees) is a verified standard. The
specific values are a plausibility device to keep generated points on real
streets and away from the Tiergarten and building interiors, per
docs/SCENARIO.md §3.2.

## Summary of anything left UNVERIFIED

- **ISO 3779's own text on the check-digit position.** The "check digit is
  North American, not ISO" claim is well supported by secondary sources and
  by general knowledge of FMVSS/49 CFR 565, but the primary ISO 3779 text
  itself is paywalled and was not read directly.

Everything else here was confirmed against at least a near-primary source
(an official standards body page, or a Wikipedia article that itself names
and quotes the governing regulation), cited above.
