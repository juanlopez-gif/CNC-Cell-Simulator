# Gauge policy: decision of step A2.2

Prepared on 2026-10-28 (PROJECT_STATUS.md §15, A2.2). The alternatives of each point were presented to
the author with their consequences; the author chose the recommended set as a whole. The specification
is summarized in PROJECT_STATUS.md §5.14 and logged in §17. **Not yet implemented in the model** (§5).

## 0. Decision (2026-10-28)

| Point | Decision |
|---|---|
| Fixture and datums | 3-2-1 nest, tilted towards the datum corner, air blow-off of nest and part before loading, one laser per axis (LS-61/62/63) |
| Distance to size | `size = 50.000 + (d_master − d_part)` per axis; a reading outside 45–52 mm is invalid and the measurement is repeated |
| Calibration | Master cube MST-60 at start-up, after every sensor verification, every 4 h and after a gauge FAULT; accepted if every axis reads 50.000 ± 0.010 mm, otherwise gauge FAULT and no part is measured until it is cleared and the master check passes |
| Uncertainty of the station | U = 0.05 mm (k = 2), estimated (§3) |
| Guard band and decision rule | Guard band inside the tolerance (ISO 14253-1, proving conformance): **OK only if L, W and H ≥ 48.05 mm**; otherwise NOK |
| Part inside the band (48.00 ≤ x < 48.05) | NOK, NOK chute, counts for the quality hold; logged as "rejected in guard band" |
| Upper limit | **None specified** by the assignment, and none invented. The validity range (≤ 52 mm) is a check of the measurement, not a tolerance |

Context that drives every choice: the tolerance is wide compared with the measurement. Good parts
come out at 50.00 ± 0.02 mm, the limit is 48.00 mm (2 mm margin) and the undersized parts of the
simulators measure 47.3–47.8 mm. An uncertainty of about 0.05 mm is forty times smaller than the
margin, so the guard band affects very few parts and the simple, conservative option costs almost
nothing.

## 1. Fixture and datums

| Option | How | Consequences |
|---|---|---|
| **A. 3-2-1 nest, one laser per axis (chosen, with the two additions)** | The part rests on three datum faces (base, back, side); each laser faces the opposite free face | 3 sensors. Bad seating (chip, burr, coolant) makes the part read **larger**, the dangerous direction: an undersized part could pass |
| B. Two opposed lasers per axis | Thickness by difference, independent of the datum faces | Immune to seating errors; 6 sensors and twice the wiring |
| C. Camera measurement | — | Not accurate enough. Rejected |

The two additions attack the cause of the only dangerous error without doubling the sensors: an
air blow-off of the nest and the part before loading (chips and coolant) and a nest tilted a few
degrees towards the datum corner, so that the part seats by gravity.

## 2. Distance to size

Each laser measures the distance `d` to the free face of the part. With the master cube of
50.000 mm in the nest the gauge stores `d_master` for each axis; then

```
L = 50.000 + (d_master,X − d_part,X)     (LS-61)
W = 50.000 + (d_master,Y − d_part,Y)     (LS-62)
H = 50.000 + (d_master,Z − d_part,Z)     (LS-63)
```

The measurement is only used near 50 mm (± 2 mm), so the linearity of the sensor matters only over
that span. A value outside 45–52 mm is not a part size but a bad reading (no part, part not seated,
chip under the part): `GAUGE.valid` is false and the measurement is repeated, as E4 already does.

## 3. Uncertainty budget (estimate)

Following the GUM. Values are **estimates** for this design, not measurements; the linearity has to
be taken from the Keyence IL-065 datasheet, and a real cell would validate the whole station with a
Gauge R&R study (out of scope).

| Component | Assumed limit | Distribution | Standard uncertainty |
|---|---|---|---:|
| Sensor repeatability | 2 µm | normal | 2.0 µm |
| Linearity over ± 2 mm around the master | ± 10 µm (to confirm on the datasheet) | rectangular | 5.8 µm |
| Master cube certificate | ± 1 µm | rectangular | 0.6 µm |
| Temperature, part 10 °C warmer than master (steel 11.5 µm/m/°C × 50 mm) | ± 6 µm | rectangular | 3.5 µm |
| Seating, flatness, burrs (after blow-off) | ± 20 µm | rectangular | 11.5 µm |
| Coolant film | ± 10 µm | rectangular | 5.8 µm |
| **Combined** | | | **14.7 µm** |
| **Expanded, k = 2** | | | **29 µm** |

**U = 0.05 mm** is used, rounded up from 0.03 mm to cover an aluminium part (twice the thermal term)
and the linearity not yet confirmed.

## 4. Calibration and decision rule

| Option for calibration | Cost | Risk |
|---|---|---|
| Start-up only | none | drift during the shift not detected |
| **Start-up, after every sensor verification, every 4 h, after a gauge FAULT (chosen)** | a few seconds of Robot 2 every 4 h, < 0.1 % of production | drift bounded to 4 h; a knock to the nest is caught |
| Every part | longer cycle | excessive for a 2 mm tolerance |

| Option for the guard band | Rule | Consequence |
|---|---|---|
| None | accept if ≥ 48.000 | shared risk: a 47.98 mm part can pass |
| **Inside (chosen, ISO 14253-1)** | accept only if ≥ 48.000 + U = 48.05 mm | no bad part passes; good parts between 48.00 and 48.05 are rejected, practically none with this process |
| Outside | reject only if < 48.000 − U | bad parts can pass; unacceptable for a final check |

| Option for a part inside the band | Consequence |
|---|---|
| **Reject (chosen)** | simplest; no new state in the machines or the verifier |
| Re-measure (re-pick, re-seat, measure again) | saves some good parts, adds a loop to verify, very rare |
| Hold for the operator | more operator load and a stop for one part |

A part this close to the limit points to tool wear, so it counts for the quality hold. An early
tool-wear warning (for example below 49.5 mm) belongs to A6 (tool wear) and is noted there.

## 5. What changes in the model (to implement)

1. `RULES`: `minSize` 48.0 stays the specified limit; new `guardBand` 0.05 (accept from
   `minSize + guardBand`), `masterTol` 0.010, `masterEveryH` 4, `validRange` [45, 52].
2. `GAUGE.ok` true only if every axis ≥ 48.05 mm, in both simulators; the log separates
   "NOK, undersized" from "NOK, rejected in guard band".
3. Master check repeated every 4 h (when Robot 2 waits for a part), after a sensor verification and
   after a gauge FAULT; a master reading outside 50.000 ± 0.010 mm raises a gauge FAULT. In the
   verifier: a new fault class for a failed master check.
4. Air blow-off as part of loading the gauge (a hardware entry and its time); nest tilt as a
   fixture note.
5. Measurement in the simulators as `50.000 + (d_master − d_part)`; readings outside 45–52 mm
   invalid.
6. New regression reference, with the intended differences listed in `regression/README.md`.

## 6. Limits of this policy

- The uncertainty budget is an estimate; no component is measured.
- Repeated invalid readings: E4 repeats the measurement until it is valid, with no limit on the
  number of attempts; a limit (and a FAULT after it) is not part of this decision.
- Common errors of the three lasers (for example a master cube that is itself wrong) are caught
  only by the master certificate and its recalibration, which are outside the cell.
- The policy assumes steel or aluminium parts; another material changes the thermal term.
