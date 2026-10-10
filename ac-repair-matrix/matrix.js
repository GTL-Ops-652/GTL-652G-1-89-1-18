/* AC Repair Matrix — content.
   Every step is one node. Edit the words here; index.html only draws them.
   Step numbers match the 2014 Repair Matrix (lasvegasair.net). A letter (11B, 28K) is a step
   that was split out of a longer 2014 page or added in 2026. RV steps are heat pump only.

   Node fields
     id        step number as a string ("18", "28k"). "end" and "done" are the finish screens.
     type      "check" asks a question, "fix" is a diagnosis + repair, "end" is the Delta T test
     title     short screen title
     diagnosis fix steps only: the one-line diagnosis shown in the red banner
     intro     optional lead-in sentence
     warn      safety callouts
     tasks     the numbered "do this" cards
     notes     tips under the tasks
     tool      inline calculator: "targets" | "shsc" | "split"
     ask       the question
     answers   [{ label, to, match? }] where `to` is another node id. `match` lists the calculator
               results that highlight this answer ("low|high" = low suction, high head).
     isNew     added in 2026 (shown in review mode)
     updated   what changed from 2014 (shown in review mode)

   System type (the two toggles in the header): layout split | pkg, heat gas | hp, so four systems:
   split-gas, split-hp, pkg-gas, pkg-hp.
   Equipment types (asked at Step 0): single = single stage, two = two-stage with conventional
   wiring, inverter = inverter / communicating.
   Reversing valve (heat pump only, asked at Step 0 and Step RV): o = energized in cooling (default),
   b = energized in heating.
     - {outdoor}, {indoor}: words swapped per system (see TERMS). {Outdoor} capitalizes it.
     - Any text, list item, answer label or `to` can instead be an object of versions keyed by
       "split-gas" / "split-hp" / "pkg-gas" / "pkg-hp", split / pkg, gas / hp, single / two / inverter, o / b, all.
       The most specific key wins, in that order: exact system, layout, heat, equipment, reversing valve, else `all`.
       Leave a type out (and no `all`) and the item doesn't show for it: { hp: "..." } is heat pump only.
       Variants can nest: { hp: { o: "...", b: "..." }, all: "..." }.
     parts     fix steps: which parts to use, usually PARTS_RULE
     systems   optional list of keys a step belongs to, e.g. ["hp"] (for the step index) */

const LAYOUTS = { split: "Split", pkg: "Package" };
const HEATS = { gas: "Gas", hp: "Heat pump" };
const EQUIPMENT = {
  single: { label: "Single stage", hint: "One-speed compressor, conventional thermostat wiring." },
  two: { label: "Two-stage", hint: "Conventional wiring: R, W, Y, G, B, C terminals." },
  inverter: { label: "Inverter", hint: "Variable-speed or communicating system." },
};
// Heat pump reversing valve: assume O unless the tech switches it to B.
const RV_MODES = {
  o: { label: "O (cooling)", hint: "O: the valve is energized in cooling. Most brands." },
  b: { label: "B (heating)", hint: "B: the valve is energized in heating and rests in cooling. Rheem and Ruud." },
};
// Parts rule (2026): universal parts are stocked on the trucks. Inverter gets OEM.
const PARTS_RULE = {
  single: "Universal is fine on a single-stage system. We stock them on the trucks.",
  two: "Universal is fine on a two-stage system with conventional wiring (R, W, Y, G, B, C).",
  inverter: "Inverter system: OEM part only.",
};
const INVERTER_NOTE = { inverter: "Inverter system: most have no contactor or run capacitor, and the drive board shows fault codes. Read the codes and follow the manufacturer's service manual before testing parts." };
const TERMS = {
  outdoor: { "split-gas": "condenser", "split-hp": "outdoor unit", pkg: "package unit" },
  indoor: { "split-gas": "furnace or air handler", "split-hp": "air handler", pkg: "blower compartment" },
};

// Field rules used by the calculators. Change a number here and every screen follows.
const FIELD_RULES = {
  evapSat: [33, 48],                         // °F normal suction saturation (Step 18)
  superheat: { min: 5, target: 10, max: 20 },
  subcool: { min: 5, target: 10, max: 20 },
  deltaT: [18, 25],                          // °F return-to-supply split (End test)
  staticMax: 0.5,                            // in. w.c. total external static when the rating plate isn't readable
};

// Target condensing temperature over ambient (CTOA) for Step 18, as [low, high] in °F.
// `seer` is the efficiency number on the condenser nameplate (SEER or SEER2).
// Field rule (2026): about 20° over ambient on older ~10 SEER systems, tightening
// to about 15° on high-efficiency units. Below the low number reads Low; normal runs 5° above it.
function ctoaTarget(seer) {
  if (seer < 13) return [20, 25];   // older systems, around 10 SEER
  if (seer < 16) return [17, 22];   // 13–15 SEER
  return [15, 20];                  // 16+ SEER, high efficiency
}

const A2L_WARN = "A2L systems (R-454B, R-32): use A2L-rated recovery, vacuum and leak-detection equipment, keep ignition sources away, ventilate, and follow the manufacturer's A2L service steps.";
const POWER_OFF = "Turn off the breaker or pull the disconnect. Verify it's dead with your meter.";
const CHARGE_EFFECT = "Adding refrigerant lowers superheat and raises subcooling. Removing it raises superheat and lowers subcooling.";
const OPEN_PANEL = { all: "Remove the electrical panel.", pkg: "Open the unit's electrical compartment door." };
const GO_INDOOR = {
  "split-gas": "Go to the furnace or air handler (attic, garage or closet). Remove the panels.",
  "split-hp": "Go to the air handler (attic, garage or closet). Remove the panels.",
  pkg: "At the package unit, open the blower compartment door, and the control compartment if the board is separate.",
};

const MATRIX = {
  start: "0",
  nodes: [
    // ───────────────────────── Start ─────────────────────────
    {
      id: "0", type: "setup", title: "What are you working on?", isNew: true,
      intro: "Set these at the start. They change the wording, add the heat pump checks, and tell you which parts to use.",
      tool: "setup",
      answers: [{ label: "Start the diagnosis", to: "1" }],
      updated: "New. Picks the system type, equipment type and refrigerant.",
    },
    {
      id: "1", type: "check", title: "Thermostat and airflow",
      tasks: [
        "Set the thermostat to Cool, fan Auto, 60°F.",
        "Wait 5 minutes for any time delays.",
        "Feel for air at a supply vent. Use a tissue if you need to.",
      ],
      notes: [
        "60°F keeps the thermostat calling for the whole diagnosis.",
        "Any air at all counts: cold, warm or room temperature.",
        { hp: "Warm air with the {outdoor} running? Keep going: Step 17 checks the reversing valve." },
      ],
      ask: "Is any air coming out of the supply vents?",
      answers: [
        { label: "Yes, I have air movement", to: "2" },
        { label: "No air movement at all", to: "28" },
      ],
    },
    {
      id: "2", type: "check", title: "Listen at the {outdoor}",
      tasks: [
        { all: "The blower is running, so grab your meter, amp clamp and gauges and head outside.", pkg: "The blower is running. Grab your meter, amp clamp and gauges." },
        { all: "Go to the {outdoor}. Listen and watch the unit.", pkg: "At the package unit, listen and watch the condenser section." },
      ],
      ask: "What is the {outdoor} doing?",
      answers: [
        { label: "Making noise, but the condenser fan isn't spinning", to: "3" },
        { label: "Looks and sounds like it's on", to: "17" },
        { label: { all: "Doing nothing. No sound, no fan", pkg: "Condenser section is doing nothing. No sound, no fan" }, to: "6" },
      ],
    },

    // ───────────────────── Condenser fan ─────────────────────
    {
      id: "3", type: "check", title: "Condenser fan not spinning",
      warn: ["Shut the power off now. The compressor overheats fast without the condenser fan."],
      tasks: [
        { all: "Pull the disconnect and remove the electrical panel.", pkg: "Pull the disconnect and open the electrical compartment door." },
        "Look for a swollen capacitor or burnt wires. Replace anything burnt and re-test.",
        "Discharge the capacitor. Label its wires and remove them.",
        "Set your meter to µF (MFD). Test C to FAN, the fan motor side.",
      ],
      notes: [
        INVERTER_NOTE,
        "Dual capacitors read like 40+5 µF: C to HERM is the compressor (40), C to FAN is the fan motor (5). Single fan capacitors are usually 3–10 µF.",
        "A capacitor is bad when it reads outside the tolerance printed on the can, usually ±5% or ±6%.",
        { hp: "On a heat pump the fan runs through the defrost board's fan relay (DF1/DF2), which opens during defrost. Before condemning the motor, check for line voltage at the motor leads with the unit calling for cooling." },
      ],
      ask: "Does the fan side of the capacitor test within tolerance?",
      answers: [
        { label: "No, it's out of tolerance", to: "4" },
        { label: "Yes, it tests good", to: "5" },
      ],
      updated: "Capacitor pass/fail now uses the tolerance printed on the can (usually ±5–6%) instead of 10%. Heat pump: added the defrost board fan relay check.",
    },
    {
      id: "4", type: "fix", title: "Replace the capacitor",
      diagnosis: "You have a bad capacitor.",
      parts: PARTS_RULE,
      warn: [POWER_OFF],
      tasks: [
        "Photograph or label each wire on the old capacitor.",
        "Match the new capacitor's µF rating exactly. Its voltage rating must be equal or higher: a 440 V can may replace a 370 V can, never the reverse.",
        "Move one wire at a time to the same terminal on the new capacitor. Crimp any loose spade terminals.",
        "Check for bare, burnt or loose wires before you close up.",
        "Clamp the compressor common wire and start the unit. Watch the start.",
      ],
      notes: [
        "Every compressor pulls close to its locked-rotor amps (LRA, on the nameplate) for a split second at start. A healthy start drops to running amps in under a second.",
      ],
      ask: "How did the compressor start?",
      answers: [
        { label: "Clean start. Run the end test", to: "end" },
        { label: "Hung near LRA, struggled or tripped", to: "16" },
      ],
      updated: "Removed the '30 amps for 1 millisecond' rule: every compressor briefly pulls near LRA. Start is now judged against nameplate LRA and how long the inrush lasts. Added the capacitor voltage-rating rule.",
    },
    {
      id: "5", type: "fix", title: "Replace the condenser fan motor",
      diagnosis: "You have a bad condenser fan motor.",
      parts: PARTS_RULE,
      warn: [POWER_OFF],
      tasks: [
        { all: "Remove the top and set it upside down. Unplug or cut the motor wires and note how they were routed.", pkg: "Remove the condenser fan grille or top panel. Unplug or cut the motor wires and note how they were routed." },
        "Loosen the blade set screw. Sand the shaft and spray it with penetrating oil.",
        "Twist the blade back and forth while pulling from the center hub only, or it will bend. Set it 5 feet away.",
        "Remove the nuts or bolts holding the motor to its mount.",
        { all: "Match the new motor's HP, RPM, voltage and rotation. Its rated amps should be equal or higher. Use the capacitor µF the new motor's label calls for.", inverter: "Use the OEM fan motor. Inverter units usually have an ECM fan motor run by the drive board." },
        { all: "Wire the two power leads to the load (T) side of the contactor, one on each leg. Capacitor leads go to C and FAN.", hp: "Wire the power leads where the old motor's were: on most heat pumps one goes to the defrost board's fan relay (DF terminal), not straight to the contactor. Capacitor leads go to C and FAN." },
        "Set the blade at the old height, tighten the set screw on the flat, and spin it by hand to check clearance. Put every screw back.",
        "Clamp one motor power lead and start the unit. Compare amps to the motor's nameplate.",
      ],
      notes: [
        "Runs backwards? Swap the rotation leads as shown on the motor label.",
        "The compressor may be sitting on its overload from running without the fan. Give it time, or cool it with a hose (power off, water away from the electrical), then try again.",
      ],
      answers: [{ label: "Motor replaced. Run the end test", to: "end" }],
    },

    // ───────────────────── Dead condenser ─────────────────────
    {
      id: "6", type: "check", title: { all: "Unit is dead: check line voltage", pkg: "Condenser section is dead: check line voltage" },
      tasks: [
        "The fan and compressor are both off, so this is most likely electrical.",
        OPEN_PANEL,
        "Set your meter to VAC. Test across L1 and L2 on the line side of the contactor.",
      ],
      notes: [INVERTER_NOTE, "The line side is where house power lands. The load (T) side feeds the compressor and fan, and only has power when the contactor closes."],
      ask: "Do you have 208–240 V at the line side of the contactor?",
      answers: [
        { label: "No line voltage", to: "7" },
        { label: "Yes, line voltage is there", to: "6b" },
      ],
      updated: "230 V is now 208–240 V.",
    },
    {
      id: "6b", type: "check", title: "Check the contactor coil",
      tasks: ["Test for 24 VAC across the two contactor coil terminals, usually on the left and right sides of the contactor."],
      ask: "Do you have 24 V at the contactor coil?",
      answers: [
        { label: "No 24 V at the coil", to: "10" },
        { label: "Yes, 24 V at the coil", to: "14" },
      ],
    },
    {
      id: "7", type: "check", title: "No power: check for a grounded compressor",
      tasks: [
        "A grounded compressor trips breakers and blows fuses, so check it first.",
        "Kill the power. Set your meter to continuity.",
        "Remove the compressor terminal wires. Scratch one lead onto bare copper on the suction line. Touch the other lead to C, S and R, one at a time.",
      ],
      notes: ["Continuity from any terminal to ground means the compressor is grounded. There's no saving it."],
      ask: "Does any compressor terminal show continuity to ground?",
      answers: [
        { label: "Yes, it's grounded", to: "22" },
        { label: "No ground", to: "7b" },
      ],
    },
    {
      id: "7b", type: "check", title: "Trace the line voltage back",
      tasks: [
        "Open the disconnect box.",
        "Test for line voltage on the LOAD side of the disconnect, then on the LINE side.",
      ],
      notes: [{ pkg: "A package unit takes all its power, blower included, from this one disconnect." }],
      ask: "Where does the voltage stop?",
      answers: [
        { label: "Disconnect load side has power, unit doesn't", to: "7w" },
        { label: "Line side has power, load side doesn't", to: "15" },
        { label: "No power coming into the disconnect", to: "7c" },
      ],
    },
    {
      id: "7c", type: "check", title: "Check the breaker",
      warn: ["Work inside the main panel belongs to a licensed electrician."],
      tasks: [
        "Find the AC breaker at the main panel. Turn it fully off, then back on.",
        "Test for line voltage leaving the breaker.",
      ],
      ask: "Is line voltage leaving the breaker after the reset?",
      answers: [
        { label: "No, still dead", to: "7e" },
        { label: "Yes, power is back", to: "7d" },
      ],
    },
    {
      id: "7d", type: "check", title: "Tighten and restart",
      tasks: [
        "Kill the power. Tighten every connection at the breaker, the disconnect and the contactor.",
        "Clamp the main power lead into the {outdoor}. Set your meter to AAC.",
        "Turn on the breaker, then the disconnect, while watching the amp clamp.",
      ],
      notes: ["A good start settles to running amps in under a second. Compare to the nameplate RLA and LRA."],
      ask: "How did it start?",
      answers: [
        { label: "Clean start. Check the pressures", to: "sp" },
        { label: "Hung near LRA, struggled or tripped", to: "16" },
      ],
      updated: "Fixed 8–25 A / 30 A numbers replaced with the unit's nameplate RLA and LRA.",
    },
    {
      id: "7e", type: "fix", title: "Replace the breaker",
      diagnosis: "The AC breaker is bad.",
      warn: ["The breaker is inside the main panel. This is a job for a licensed electrician."],
      tasks: [
        "The replacement breaker must match the unit's nameplate MOCP (maximum fuse or breaker size).",
        "When it's replaced, restart the matrix to make sure nothing else is wrong.",
      ],
      answers: [{ label: "Breaker replaced. Restart the matrix", to: "1" }],
    },
    {
      id: "7w", type: "fix", title: "Replace the electrical whip",
      diagnosis: "The whip between the disconnect and the unit is open.",
      warn: [POWER_OFF],
      tasks: [
        "Replace the liquid-tight whip and its connectors. Size the wire for the unit's MCA (minimum circuit ampacity) on the nameplate.",
        "House wires land on LINE (L1/L2), unit wires on LOAD (T1/T2). Ground both whips.",
        "Restore power and start the unit with your amp clamp on.",
      ],
      answers: [{ label: "Whip replaced. Run the end test", to: "end" }],
    },

    // ───────────────────── Coil, vacuum, charge ─────────────────────
    {
      id: "8", type: "fix", title: "Clean the coil",
      diagnosis: "The coil is dirty.",
      warn: ["Turn off all power to the unit."],
      tasks: [
        "Brush or vacuum the loose debris off the coil first.",
        "Use a coil cleaner the coil manufacturer approves. Never use acid on aluminum fins or microchannel coils.",
        "Outdoor coil: apply the cleaner, give it the time on the label, then rinse from the inside out with low-pressure water.",
        { all: "Evaporator coil: make sure the drain is clear, then use a no-rinse evaporator cleaner and let the condensate carry it away.", pkg: "Indoor coil (behind the panel inside the unit): make sure the drain and trap are clear, then use a no-rinse evaporator cleaner and let the condensate carry it away." },
        "Straighten bent fins with a fin comb. Close up and re-test in cooling.",
      ],
      notes: ["Microchannel coils (flat aluminum tubes): water, or a cleaner the manufacturer approves for microchannel only."],
      answers: [
        { label: "Coil cleaned. Check airflow and the pressures", to: "sp" },
        { label: "Coil cleaned. Run the end test", to: "end" },
      ],
      updated: "Replaced the acid wash (1 part acid to 2 parts water). Acid eats aluminum fins and microchannel coils and can void the coil warranty.",
    },
    {
      id: "9", type: "fix", title: "Evacuate and charge",
      warn: [A2L_WARN],
      tasks: [
        "Before you charge, confirm the airflow: filter clean, blower on the cooling speed, and total external static within the rating (Step SP). You can't dial in a charge with the wrong airflow.",
        { all: "Install a new liquid line filter drier any time the system has been opened.", hp: "Install a new bi-flow filter drier any time the system has been opened. A heat pump needs bi-flow; a standard drier blocks heating mode." },
        "Put your micron gauge at the system, away from the pump. Core removal tools and large hoses make the vacuum much faster.",
        "Pull down to 500 microns or lower.",
        "Isolate the pump and wait 10 minutes. Holding steady below 1,000 microns means tight and dry. Rising past 1,000 means a leak or moisture.",
        { all: "Weigh in the nameplate charge, plus the line set adjustment from the installation manual if the lines are longer than the factory charge covers.", pkg: "Weigh in the full nameplate charge. A package unit has no line set, so there's no adjustment." },
        "Blends (R-410A, R-454B) leave the cylinder as liquid. With the unit running, meter it slowly into the suction side.",
        { all: "Run 15 minutes, then fine-tune. TXV: charge to the manufacturer's subcooling target on the data plate. Piston: charge to target superheat from the manufacturer's chart.", hp: "Run 15 minutes in cooling, then fine-tune with the cooling charging chart. TXV: charge to the subcooling target on the data plate. Piston: charge to target superheat from the manufacturer's chart." },
      ],
      notes: [
        CHARGE_EFFECT,
        "No manufacturer data? Aim for 10°F superheat and 10°F subcooling, and keep both between 5°F and 20°F.",
      ],
      tool: "shsc",
      ask: "How did it go?",
      answers: [
        { label: "Held vacuum and charged on target. Run the end test", to: "end" },
        { label: "Vacuum won't hold (rises past 1,000 microns)", to: "21" },
        { label: "Can't reach the targets. Restart the matrix", to: "1" },
      ],
      updated: "Weigh-in charge and the manufacturer's subcooling/superheat targets replace 'fill until it slows down'. Removed 'don't go below 300 microns' (a deep vacuum doesn't hurt modern oil). Added liquid charging for blends and A2L safety. Heat pump: bi-flow drier, cooling chart. Package: no line set adjustment.",
    },

    // ───────────────────── Low-voltage signal ─────────────────────
    {
      id: "10", type: "check", title: "No 24 V at the coil: check the signal in",
      tasks: [
        { all: "Find where the thermostat wire enters the {outdoor}.", pkg: "Find where the thermostat wire lands in the unit: the low-voltage terminal board or pigtails in the control compartment." },
        { all: "Test for 24 V between the two low-voltage wires (Y and C) at the splices or terminal strip.", hp: "Test for 24 V between Y and C where the thermostat wire lands, usually on the defrost board.", pkg: "Test for 24 V between Y and C there." },
      ],
      ask: "Is 24 V coming in on Y?",
      answers: [
        { label: "No 24 V coming in", to: { all: "11", pkg: "11c" } },
        { label: "Yes, but it doesn't reach the coil", to: "10b" },
      ],
    },
    {
      id: "10b", type: "check", title: "Find the open safety switch",
      warn: ["Remove any jumper as soon as you have your reading. Never leave a safety switch bypassed."],
      tasks: [
        { all: "Between the 24 V input and the contactor coil there's usually a low-pressure switch, sometimes a high-pressure switch, and on some units a control board.", hp: "On a heat pump the defrost board sits between Y and the contactor, with the pressure switches wired into the board. Check for 24 V on Y in and on the board's contactor output (Y-OUT or CC)." },
        { all: "Check any control board on the unit for a fault code, lockout or anti-short-cycle delay.", hp: "Read the defrost board's LED. A pressure switch trip, a lockout or the 5-minute anti-short-cycle delay all hold the contactor out. Y in but nothing out, with no fault code and no delay, means a bad defrost board." },
        "Hook up your gauges.",
        "Jumper the low-pressure switch leads so the unit runs. Read the suction saturation temperature.",
      ],
      notes: [
        "A low-pressure switch that opens at a suction saturation below about 20°F is doing its job: you have a refrigerant problem.",
        "If it's the high-pressure switch that's open, look for high head pressure on the gauges.",
      ],
      ask: "What did you find?",
      answers: [
        { label: "Suction saturation is low (below about 20°F)", to: "sp" },
        { label: "The high-pressure switch is open", to: "sp" },
        { label: "Suction is normal: the switch opened for no reason", to: "13" },
        { label: { hp: "Y in, nothing out, no fault: the defrost board is bad" }, to: "29" },
      ],
      updated: "The 2014 '40 psi' cut-off was an R-22 number. Now uses saturation temperature, which works for any refrigerant. Added high-pressure switches and unit control boards. Heat pump: the defrost board between Y and the contactor.",
    },
    {
      id: "11", systems: ["split"], type: "check", title: "At the {indoor}: confirm the fan call",
      tasks: [
        GO_INDOOR,
        "Jumper or hold in the door switch and wait 5 minutes for time delays.",
        "Test for 24 V between C and G on the control board.",
      ],
      notes: ["You had air at the vents, so the board had power, the transformer made 24 V and the thermostat closed the fan relay. This step double-checks that."],
      ask: "Do you have 24 V at C and G?",
      answers: [
        { label: "No 24 V at C and G", to: "28" },
        { label: "Yes", to: "11b" },
      ],
    },
    {
      id: "11b", systems: ["split"], type: "check", title: "Check the cooling call (Y)",
      tasks: ["Test for 24 V between C and Y on the control board. If the Y wires are spliced off the board, test at the Y splice and C."],
      ask: "Do you have 24 V at C and Y?",
      answers: [
        { label: "No 24 V at C and Y", to: "11c" },
        { label: "Yes, but it never reaches the {outdoor}", to: "11w" },
      ],
    },
    {
      id: "11c", type: "check", title: "Find what's blocking the thermostat signal", isNew: true,
      tasks: [
        { all: "Check for condensate float switches: in the drain pan, the secondary pan or on the drain line. Most break the thermostat signal (R or Y) when water backs up.", pkg: "Check for a condensate float switch in the unit's drain pan or on the drain line. Most break the thermostat signal (R or Y) when water backs up." },
        "On A2L systems (R-454B, R-32), check the refrigerant detection board. A leak or a sensor fault cuts the cooling call and runs the blower.",
        { all: "Pull the thermostat off its base. Jumper R to Y, and R to G if the fan call is missing too.",
          hp: { o: "Pull the thermostat off its base. Jumper R to Y and R to O (cooling), and R to G if the fan call is missing too.",
                b: "Pull the thermostat off its base. Jumper R to Y, and R to G if the fan call is missing too. Leave B off: the valve rests in cooling." } },
      ],
      ask: "What did you find?",
      answers: [
        { label: "A float switch is tripped, water in the pan", to: "35" },
        { label: "The A2L detection board shows a leak or fault", to: "36" },
        { label: "Jumpering at the thermostat base brings it on", to: "32" },
        { label: "Still no signal with the jumper", to: "11w" },
      ],
      updated: "New. The 2014 matrix went straight to 'bad thermostat'. Float switches and A2L leak detection boards are common reasons the signal goes missing.",
    },
    {
      id: "11w", type: "fix", title: "Repair the thermostat wire",
      diagnosis: "You have a broken low-voltage wire.",
      tasks: [
        { all: "Find which run is open: thermostat to {indoor}, or {indoor} to {outdoor}.", pkg: "Find which run is open: the thermostat cable from the house to the unit, or the wiring inside the unit between the terminal board and the contactor." },
        "Move the circuit to a spare conductor in the same cable. Change the color at both ends.",
        "No spare? Run a new cable. Use at least 18/5 so there's a C wire and a spare.",
      ],
      answers: [{ label: "Wire repaired. Restart the matrix", to: "1" }],
    },
    {
      id: "13", type: "fix", title: "Replace the pressure switch",
      diagnosis: "You have a bad pressure switch.",
      parts: PARTS_RULE,
      warn: [A2L_WARN],
      tasks: [
        "Check how it's mounted. Many switches thread onto a Schrader fitting with a depressor and can be changed without recovering the charge.",
        "Brazed in, or no valve under it? Recover the refrigerant. Open every valve on the gauges, hoses, recovery machine and tank before you start the machine.",
        "Cut the switch wires. Unscrew the switch using a backup wrench so the copper doesn't twist.",
        "Brazed-in switch: flow nitrogen while you braze and wrap the new switch with heat-sink paste or a wet rag.",
        "Install the new switch, snug plus a quarter turn, and reconnect the wires.",
      ],
      answers: [
        { label: "Recovered and replaced. Evacuate and charge", to: "9" },
        { label: "Changed on a Schrader fitting. Run the end test", to: "end" },
      ],
      updated: "Added: many switches change without recovery. Added flowing nitrogen while brazing.",
    },
    {
      id: "14", type: "check", title: "Power and signal good: check the contactor",
      tasks: [
        "You have line voltage at the line side and 24 V at the coil, but the unit is dead.",
        "Watch for burnt or broken wiring through every step. Repair anything you find.",
        "Test for line voltage across T1 and T2, the load side of the contactor.",
      ],
      notes: [INVERTER_NOTE],
      ask: "Do you have line voltage at the load side?",
      answers: [
        { label: "No, the contactor isn't closing", to: "34" },
        { label: "Yes, power passes through", to: "14b" },
      ],
    },
    {
      id: "14b", type: "check", title: "Test the dual capacitor",
      tasks: [
        "The fan and compressor both have power, but neither runs.",
        "Kill the power. Discharge the capacitor, label the wires and remove them.",
        "Test C to HERM (compressor) and C to FAN (fan motor) in µF.",
      ],
      notes: [
        "Example: a 45+5 µF capacitor should read about 45 on C–HERM and about 5 on C–FAN, within the tolerance on the label.",
        "Both sides good? Then the fan motor is bad, and the compressor is likely sitting on its overload from running without it.",
        { hp: "Heat pump: check the fan is getting power through the defrost board's fan relay before you condemn the motor." },
      ],
      ask: "Does the capacitor test within tolerance?",
      answers: [
        { label: "No, one side is out", to: "4" },
        { label: "Yes, both sides are good", to: "5" },
      ],
    },
    {
      id: "15", type: "fix", title: "Replace the disconnect",
      diagnosis: "The disconnect is bad or burnt, or its fuses are blown.",
      warn: ["Turn off the AC breaker at the main panel. Verify it's dead with your meter."],
      tasks: [
        "Fused disconnect with blown fuses: replace them with the size on the unit nameplate (MOCP). If they blow again, find the short before going further.",
        "Loosen all the wires. Take apart any thermostat wire splices in the box and note how they go back.",
        "Loosen the whip locknuts, pull the whips, and unscrew the old disconnect. Cut any sealant carefully.",
        "Knock out the new disconnect to match, mount it, and reconnect the whips with their locknuts.",
        "House wires to LINE (L1/L2). Unit wires to LOAD (T1/T2). Both grounds to the ground lug.",
        "Re-splice any thermostat wires neatly. Check every connection is tight, then close the cover.",
        "Restore power and start the unit with your amp clamp on.",
      ],
      notes: ["Disconnects burn from loose connections or wire that's too small. Compare the wire and breaker to the nameplate MCA and MOCP."],
      ask: "How did it start?",
      answers: [
        { label: "Clean start. Run the end test", to: "end" },
        { label: "Hung near LRA, struggled or tripped", to: "16" },
      ],
      updated: "'Above 40 amps' rule replaced with nameplate LRA. Added the MCA/MOCP check to find why it burned.",
    },
    {
      id: "16", type: "fix", title: "Install a hard-start kit",
      diagnosis: "The compressor is hard-starting.",
      tasks: [
        "A hard-start kit gives the compressor extra torque at start. It can save a struggling compressor and cuts wear on a healthy one.",
        "Kill the power. Mount the kit inside the electrical panel.",
        "Connect its two leads to HERM and C on the run capacitor. Follow the kit's diagram if it has more leads.",
        "Restart with your amp clamp on the compressor common and compare the start to before.",
      ],
      notes: [
        "Don't install a hard-start kit on an inverter or variable-speed compressor. Check with the manufacturer.",
        "Still struggling with the kit on? Plan for a compressor replacement soon.",
      ],
      answers: [
        { label: "Kit installed. Check the pressures", to: "sp" },
        { label: "Still won't start. Replace the compressor", to: "22" },
      ],
      updated: "Added: not for inverter or variable-speed compressors.",
    },

    // ───────────────────── Running, not cooling ─────────────────────
    {
      id: "17", type: "check", title: "Running but not cooling",
      tasks: [
        "A spinning fan and a humming unit don't prove the compressor is running.",
        { hp: { pkg: "Open the compressor compartment and feel the large vapor line from the indoor coil to the reversing valve. In cooling it should be cold. Hot means the reversing valve is in heating.",
               all: "Feel the large (vapor) line at the outdoor unit. In cooling it should be cold and sweating. Hot means the reversing valve is in heating." } },
        OPEN_PANEL,
        "Clamp the compressor common (C) wire.",
      ],
      notes: [INVERTER_NOTE, "Running amps should be near the nameplate RLA, lower in mild weather or when it's low on charge."],
      ask: "Is the compressor pulling running amps?",
      answers: [
        { label: "Yes, the compressor is running", to: "sp" },
        { label: "No amps at all", to: "23" },
        { label: { hp: "Running, but the large line is hot: it's heating" }, to: "rv" },
      ],
      updated: "The compressor common isn't a '120 V' wire. Amps compared to nameplate RLA instead of a fixed 3–25 A. Heat pump: added the hot vapor line check for a reversing valve stuck in heat.",
    },
    {
      id: "sp", type: "check", title: "Check airflow first: static pressure", isNew: true,
      intro: "Refrigerant readings are only as good as the airflow. If the airflow isn't right, you can't judge or dial in the charge, so check it before you touch the refrigerant.",
      tasks: [
        "Check the filter first. A dirty or too-restrictive filter is the most common airflow problem.",
        "Run the blower in cooling. Confirm it's on the cooling speed: about 350–400 CFM per ton.",
        { all: "With a manometer, measure return static between the filter and the blower, and supply static in the supply plenum after the coil.", pkg: "With a manometer, measure return and supply static at the unit's return and supply openings, or right at the curb transitions." },
        "Add the two readings, ignoring the minus sign. That's your total external static pressure.",
        "Compare it to the maximum on the {indoor}'s rating plate. Residential equipment is usually rated around 0.5 in. w.c.; some ECM blowers are rated higher.",
      ],
      tool: "static",
      notes: ["Use the manufacturer's blower table at your static reading to see the actual CFM for the speed tap you're on."],
      ask: "Is the airflow right?",
      answers: [
        { label: "Static is within the rating and the blower is on the cooling speed", to: "18", match: ["normal"] },
        { label: "Static is too high", to: "sp2", match: ["high"] },
        { label: "Static is low, but airflow is still weak", to: "37" },
        { label: "The blower isn't running", to: "28" },
      ],
      updated: "New. Every path to the pressures (Step 18) checks airflow first, because you can't dial in a charge with the wrong airflow.",
    },
    {
      id: "sp2", type: "check", title: "Find the airflow restriction", isNew: true,
      tasks: [
        "Split your readings: high return static points to the filter or return duct. High supply static points to the coil or supply duct.",
        { all: "Look at the evaporator coil where the air enters, the filter, and the blower wheel.", pkg: "Open the unit and look at the indoor coil where the air enters, the filter, and the blower wheel." },
        "Look for closed dampers, crushed or undersized duct, and blocked returns or registers.",
      ],
      ask: "What's restricting the airflow?",
      answers: [
        { label: "The evaporator coil is dirty", to: "8" },
        { label: "Filter, ducts, dampers, blower wheel or blower speed", to: "37" },
      ],
    },
    {
      id: "18", type: "check", title: "Read the pressures",
      intro: "This step covers most refrigerant problems. Take your time and get good readings.",
      tasks: [
        { all: "Hook up your gauges and set the refrigerant.", hp: { pkg: "Hook up your gauges at the unit's suction and liquid service ports and set the refrigerant.",
               all: "Hook up your gauges at the outdoor service valves (suction on the large line, liquid on the small line) and set the refrigerant." } },
        "Measure outdoor ambient 6 inches in front of the condenser coil, in the shade.",
        "Read the head (liquid line) saturation temperature and compare it to the target below.",
        "Read the suction saturation temperature. Normal is 33–48°F, toward the top when the house is hot.",
      ],
      tool: "targets",
      notes: [
        "Inverter and variable-speed systems: use the manufacturer's charging chart or app. These rules of thumb don't apply.",
        { hp: "Heat pump: high suction with low head often means the reversing valve is leaking through, which looks just like bad compressor valves. Check the valve first." },
      ],
      ask: "What are your suction and head pressures?",
      answers: [
        { label: "Low suction, high head", to: "19", match: ["low|high"] },
        { label: "Low suction, normal head", to: "20", match: ["low|normal"] },
        { label: "Low suction, low head", to: "21", match: ["low|low"] },
        { label: "High suction, low head", to: { all: "22", hp: "rv" }, match: ["high|low"] },
        { label: "High head, suction normal or high", to: "18b", match: ["normal|high", "high|high"] },
        { label: "Normal suction, normal head", to: "18a", match: ["normal|normal"] },
      ],
      updated: "Targets are now saturation temperatures for any refrigerant, with a live calculator. The 2014 '58–80 psi' suction target was R-22 only. Added the high-head path (dirty condenser, slow fan, overcharge), which 2014 didn't have. Heat pump: high suction and low head checks the reversing valve before the compressor.",
    },
    {
      id: "18a", type: "fix", title: "Dial in the charge",
      diagnosis: "Pressures are good. The system is working.",
      tasks: [
        "Good pressures mean cold air inside. Now dial in the charge so the compressor lasts.",
        { all: "TXV: charge to the subcooling target on the data plate. Piston: charge to target superheat from the manufacturer's chart.", hp: "Use the cooling charging chart. TXV: charge to the subcooling target on the data plate. Piston: charge to target superheat from the manufacturer's chart." },
        "No data? Get as close to 10°F superheat and 10°F subcooling as you can, without going under 5°F or over 20°F on either.",
      ],
      notes: [CHARGE_EFFECT],
      tool: "shsc",
      answers: [{ label: "Charge dialed in. Run the end test", to: "end" }],
      updated: "Manufacturer targets come first. '10 and 10' stays as the fallback.",
    },
    {
      id: "18b", type: "check", title: "High head pressure", isNew: true,
      tasks: [
        "Look at the condenser coil, inside and out: dirt, cottonwood, grass, dryer lint, or a wall or fence too close.",
        "Watch the condenser fan. Is it at full speed and pulling air through the coil?",
        "Check subcooling.",
      ],
      tool: "shsc",
      ask: "What did you find?",
      answers: [
        { label: "The condenser coil is dirty or blocked", to: "8" },
        { label: "The condenser fan is slow or weak", to: "3" },
        { label: "Coil and fan are fine, subcooling is high", to: "18c" },
      ],
      updated: "New step. High head pressure, the most common summer call in the desert, had no path in 2014.",
    },
    {
      id: "18c", type: "fix", title: "Overcharge or non-condensables", isNew: true,
      diagnosis: "The system is overcharged, or has air or nitrogen in it.",
      tasks: [
        "High subcooling with low superheat: it's overcharged. Recover refrigerant slowly until both are on target.",
        "To check for non-condensables, shut the unit off and let the pressures equalize with the condenser at outdoor temperature.",
        "If the standing pressure is well above the PT pressure for the outdoor temperature, there's air or nitrogen in the system. Recover the charge, replace the drier, evacuate and weigh in a fresh charge.",
      ],
      tool: "shsc",
      answers: [
        { label: "Removed the extra charge. Run the end test", to: "end" },
        { label: "Non-condensables. Evacuate and charge", to: "9" },
      ],
    },
    {
      id: "19", type: "fix", title: "Clear the restriction (Fix All)",
      diagnosis: "You have a restriction at the metering device or filter drier.",
      intro: "High head with low suction: the compressor is pumping, but refrigerant is backing up before the metering device.",
      warn: [A2L_WARN],
      tasks: [
        "Recover all the refrigerant.",
        { all: "Piston: open the distributor at the indoor coil with two wrenches. Save the O-ring and note which way the piston faces. Clean the piston and pull out any screen in the line.", hp: "Piston: in cooling, the restriction is at the indoor coil's piston. Open its distributor with two wrenches, save the O-ring and note which way the piston faces. Clean the piston and pull out any screen. Leave the outdoor (heating) piston alone.", "pkg-hp": "Piston: in cooling, the restriction is at the indoor coil's piston. Remove the panel over the indoor coil inside the unit and open its distributor with two wrenches. Save the O-ring and note which way the piston faces. Clean the piston and pull out any screen. Leave the outdoor (heating) piston alone.",
          pkg: "Piston: remove the panel over the indoor coil inside the unit and open the distributor with two wrenches. Save the O-ring and note which way the piston faces. Clean the piston and pull out any screen." },
        "TXV: check that the sensing bulb is tight to the suction line and insulated. A TXV that stays starved with a good bulb and good charge needs replacing.",
        { all: "Cut out the liquid line filter drier and braze in a new one, arrow pointing toward the indoor coil. Flow nitrogen while brazing.", hp: "Cut out the filter drier and braze in a new bi-flow drier. Flow nitrogen while brazing." },
        { all: "Blow nitrogen through the liquid line, then the suction line, to clear debris.", pkg: "Blow nitrogen through the liquid tubing to clear debris." },
        "Reinstall the piston, pointed end first, with a new O-ring (or install the new TXV). Snug plus a quarter turn.",
      ],
      notes: ["Fix All: while the system is open and empty, clear the metering device, change the drier and blow out the lines all at once. Then the restriction is gone for good."],
      answers: [{ label: "Restriction cleared. Evacuate and charge", to: "9" }],
      updated: "Added TXV checks and flowing nitrogen while brazing. Heat pump: bi-flow drier, and only the indoor piston matters in cooling.",
    },
    {
      id: "20", type: "check", title: "Low suction, normal head: check airflow",
      intro: "Normal head rules out a low charge and most restrictions. Low suction with normal head usually means not enough air across the evaporator.",
      tasks: [{ all: "At the {indoor}, confirm the blower is running by sound and vibration.", pkg: "Open the blower compartment and confirm the blower is running." }],
      ask: "Is the blower running?",
      answers: [
        { label: "No", to: "28" },
        { label: "Yes", to: "20b" },
      ],
    },
    {
      id: "20b", type: "check", title: "Check the filter and evaporator coil",
      tasks: [
        "Check the filter. Replace it if it's dirty.",
        { all: "Open the coil access and look at the side the air enters (the side closest to the blower on a furnace).", pkg: "Remove the panel over the indoor coil and look at the side the air enters." },
      ],
      notes: ["A frozen coil has to thaw before you can judge the charge. Run fan only (fan On, cooling off) until it's clear."],
      ask: "Is the evaporator coil dirty?",
      answers: [
        { label: "Yes, the coil is dirty", to: "8" },
        { label: "No, it's clean", to: "20c" },
      ],
    },
    {
      id: "20c", type: "check", title: "Look for a duct problem",
      tasks: [
        { all: "Look for crushed or kinked return duct, insulation sucked into a duct, closed dampers or blocked returns.", pkg: "Check the supply and return ducts where they connect at the roof curb or wall, and look for crushed duct, closed dampers or blocked returns." },
        "If you have a manometer, measure total external static pressure and compare it to the unit's rating plate (often 0.5 in. w.c.).",
      ],
      notes: ["Good airflow and normal head leaves a partial restriction. Do the Fix All."],
      ask: "Did you find an airflow problem?",
      answers: [
        { label: "Yes, a duct, filter or return problem", to: "37" },
        { label: "No airflow problem", to: "19" },
      ],
      updated: "Added the static pressure check.",
    },
    {
      id: "21", type: "fix", title: "Find and fix the leak",
      diagnosis: "Low suction and low head: the system is low on charge. You have a leak.",
      warn: [A2L_WARN],
      tasks: [
        "Find and fix the leak before adding refrigerant. Topping off a leaking system just loses the charge again.",
        "Look for oily spots first. Refrigerant carries compressor oil, so leaks leave an oily, dirty stain. Check service valves, flare nuts, braze joints and coil U-bends.",
        { hp: "Heat pumps also leak at the reversing valve's brazed joints, the accumulator and the defrost sensor clamp area." },
        "Sweep with an electronic leak detector rated for the refrigerant, then confirm with soap bubbles on every joint, valve core and spot where copper rubs metal.",
        "Still can't find it? Recover the charge. Pressurize with dry nitrogen to the test pressure in the installation manual, never above the low-side test pressure on the nameplate, and bubble everything again. A falling standing pressure confirms a leak.",
        "Release the nitrogen. Clean the leak area to bright copper with sandpaper and a wire brush.",
        "Braze with 15% silver (or the right alloy for aluminum), flowing nitrogen. Heat the copper until it melts the rod; don't melt the rod with the flame.",
      ],
      notes: ["Leaking indoor coils often aren't worth repairing. Check the warranty and replacement options."],
      answers: [{ label: "Leak sealed. Evacuate and charge", to: "9" }],
      updated: "Removed R-22 price notes. Added electronic leak detection, the manufacturer's nitrogen test pressure (2014 said 250 psi for everything) and A2L-rated detectors.",
    },
    {
      id: "22", type: "fix", title: "Replace the compressor",
      diagnosis: "The compressor is bad: grounded, locked, open or not pumping.",
      parts: { all: "Match the compressor to the nameplate model or the manufacturer's listed replacement.", inverter: "Inverter system: OEM compressor only, matched to the drive board." },
      intro: "With a compressor change, also replace the contactor, run capacitor and filter drier, and clear the metering device while the system is open.",
      warn: [A2L_WARN],
      tasks: [
        "Recover all the refrigerant. Pull both Schrader cores.",
        "Check the oil with an acid test kit. A burnout also needs a suction line filter drier.",
        { all: "Remove the top and note the fan wiring. Remove the compressor wires (C, R, S) and throw them away.", pkg: "Open the compressor compartment and note the wiring. Remove the compressor wires (C, R, S) and throw them away." },
        "Remove the 4 mounting bolts. Unbraze the suction and discharge lines at the nearest joints, flowing nitrogen. Lift the compressor out.",
        "Set the new compressor on its new grommets and bolt it down. Clean the copper well.",
        { all: "Blow nitrogen through both lines. Replace the filter drier (never two in a row) and clear the metering device as in Step 19.", hp: "Blow nitrogen through both lines. Replace the drier with a bi-flow drier, check the accumulator for oil and debris, and clear the indoor metering device as in Step 19." },
        "Braze in the new compressor, flowing nitrogen. Install new Schrader cores.",
        "Start the vacuum. While it pulls down, replace the contactor and capacitor, one wire at a time.",
        "Wire the compressor: C to one load terminal of the contactor. R to the other load terminal, with a jumper from that terminal to C on the capacitor. S to HERM on the capacitor.",
        { all: "Reinstall the top and route the fan wires so the blade can't touch them.", pkg: "Close up the compressor compartment and route the wires away from the fan." },
        { all: "Hold vacuum (500 microns, holding under 1,000), then weigh in the nameplate charge plus any line set adjustment.", pkg: "Hold vacuum (500 microns, holding under 1,000), then weigh in the full nameplate charge." },
        "Start with your amp clamp on the compressor common. Watch the start against LRA and the running amps against RLA.",
        "Fine-tune superheat and subcooling as in Step 9.",
      ],
      notes: ["Won't start after the change? Check the C, R and S wiring first."],
      answers: [
        { label: "Replaced and charged. Run the end test", to: "end" },
        { label: "New compressor is hard-starting", to: "16" },
        { label: "Vacuum won't hold", to: "21" },
      ],
      updated: "Fixed a 2014 wiring summary error (R jumps to C on the capacitor, not H). Added acid test, suction drier on burnouts, flowing nitrogen and weigh-in charge.",
    },
    {
      id: "23", type: "check", title: "Compressor won't run: test the capacitor",
      tasks: [
        "Pull the disconnect.",
        "Look for burnt or loose wiring at the contactor, the capacitor and under the compressor terminal cover.",
        "Discharge the capacitor, label the wires and remove them.",
        "Test C to HERM in µF. Compare it to the rating (the bigger number on a dual capacitor).",
      ],
      notes: [INVERTER_NOTE],
      ask: "Does the HERM side test within tolerance?",
      answers: [
        { label: "No", to: "4" },
        { label: "Yes. Wires back on", to: "23b" },
      ],
    },
    {
      id: "23b", type: "check", title: "Watch it try to start",
      tasks: [
        "Good capacitor, good wiring, good voltage, and the compressor still doesn't run. Either it's bad, or it's hot and on its internal overload.",
        { all: "Make sure the top is on and nothing blocks the fan blade.", pkg: "Make sure the panels are on and nothing blocks the condenser fan." },
        "Clamp the compressor common and restore power.",
      ],
      ask: "What does the compressor do?",
      answers: [
        { label: "Starts and runs normally", to: "sp" },
        { label: "Hums near LRA, struggles or trips", to: "16" },
        { label: "Pulls no amps at all", to: "24" },
      ],
    },
    {
      id: "24", type: "check", title: "Cool down the compressor",
      intro: "No amps means the windings are open, usually the internal overload on a hot compressor. Let's see if it resets.",
      warn: ["Power off. Keep water away from the electrical panel."],
      tasks: [
        { all: "Remove the top so you can reach the compressor.", pkg: "Open the compressor compartment so you can reach the compressor." },
        "Run a garden hose over the compressor shell for 10–15 minutes.",
        "Optional: power off and wires removed, check C–R and C–S resistance. An open reading on a hot compressor often clears as it cools.",
        { all: "Put the top back on and check the fan blade is clear.", pkg: "Close the compartment and check the fan blade is clear." },
        "Clamp the compressor common, restore power and start it.",
      ],
      ask: "What happens now?",
      answers: [
        { label: "Still won't start", to: "22" },
        { label: "Starts but struggles near LRA", to: "16" },
        { label: "Starts and runs normally", to: "24b" },
      ],
      updated: "Fixed: the meter goes on AAC (amps), not µF. Added the winding resistance check.",
    },
    {
      id: "24b", type: "check", title: "Why did it overheat?",
      tasks: [
        "Compressors don't usually overheat on their own. Let it run a few minutes.",
        "Clamp the condenser fan motor and feel the motor body.",
      ],
      ask: "Is the fan motor running hot or over its nameplate amps?",
      answers: [
        { label: "Yes, it's hot or over amps", to: "5" },
        { label: "No, it runs cool", to: "sp" },
      ],
    },
    {
      id: "26", type: "fix", title: "Find the low-voltage short",
      diagnosis: "You have a short in the low-voltage circuit.",
      tasks: [
        { all: "The usual culprit is thermostat wire: nicked, pinched or chewed, often at the {outdoor}.", pkg: "The usual culprit is thermostat wire: nicked, pinched or chewed, often where it enters the unit." },
        "Remove the thermostat wires from the board's low-voltage terminals.",
        "Replace the fuse and restore power. If it holds, the short is in the wiring.",
        "Reconnect one wire at a time. When the fuse blows, that wire is the short.",
        "Move that circuit to a spare conductor, or run a new cable.",
        { all: "Fuse blows with everything disconnected? Look for a shorted part: contactor coil, gas valve, float switch or the board itself.", hp: "Fuse blows with everything disconnected? Look for a shorted part: contactor coil, reversing valve coil, defrost board, float switch or the board itself." },
      ],
      answers: [{ label: "Short repaired. Run the end test", to: "end" }],
      updated: "Added: check for shorted parts when the wiring isn't it.",
    },

    // ───────────────────── No airflow (indoor) ─────────────────────
    {
      id: "28", type: "check", title: { all: "No airflow: go to the {indoor}", pkg: "No airflow: open the blower compartment" },
      tasks: [
        { all: "Go to the {indoor}. Remove both panels.", pkg: "At the package unit, open the blower compartment door, and the control compartment if the board is separate." },
        "Check the low-voltage fuse on the control board (usually 3 or 5 A).",
      ],
      ask: "What did the fuse do?",
      answers: [
        { label: "Blown. I replaced it and it blew again", to: "26" },
        { label: "Blown. I replaced it and it holds", to: "1" },
        { label: "The fuse is good", to: "28b" },
      ],
    },
    {
      id: "28b", type: "check", title: "Line voltage into the board",
      tasks: [
        "Jumper or hold in the door switch. Wait 5 minutes for time delays.",
        { "split-gas": "Test for line voltage into the control board: 120 V on a gas furnace, 208–240 V on an electric air handler.", hp: "Test for 208–240 V into the air handler's control board.", pkg: "Test for line voltage into the control board and transformer. They're fed from the unit's 208–240 V supply." },
      ],
      ask: "Do you have line voltage into the board?",
      answers: [
        { label: "No", to: "33" },
        { label: "Yes", to: "28c" },
      ],
      updated: "Added 208–240 V air handlers. 2014 only covered 115 V furnaces.",
    },
    {
      id: "28c", type: "check", title: "Line voltage to the transformer",
      tasks: ["Test for line voltage at the transformer primary."],
      ask: "Does the transformer primary have line voltage?",
      answers: [
        { label: "No, the board isn't passing it", to: "29" },
        { label: "Yes", to: "28d" },
      ],
    },
    {
      id: "28d", type: "check", title: "Transformer output",
      tasks: ["Test for 24 V at the transformer secondary."],
      ask: "Is the transformer putting out 24 V?",
      answers: [
        { label: "No", to: "30" },
        { label: "Yes", to: "28e" },
      ],
    },
    {
      id: "28e", type: "check", title: "24 V at the board",
      tasks: ["Test for 24 V between R and C on the control board."],
      ask: "Do you have 24 V at R and C?",
      answers: [
        { label: "No, the board isn't passing it", to: "29" },
        { label: "Yes", to: "28f" },
      ],
    },
    {
      id: "28f", type: "check", title: "Fan call from the thermostat",
      tasks: ["With the thermostat on Cool, test for 24 V between G and C on the board."],
      ask: "Do you have 24 V at G and C?",
      answers: [
        { label: "No, the call isn't reaching the board", to: "11c" },
        { label: "Yes", to: "28g" },
      ],
      updated: "2014 sent this straight to 'bad thermostat'. Now it checks float switches and wiring first.",
    },
    {
      id: "28g", type: "check", title: "What kind of blower motor?", isNew: true,
      tasks: [
        "PSC motors have a run capacitor and several colored speed-tap wires.",
        "ECM motors (X13 or variable speed) have no run capacitor and plug in with molded connectors.",
      ],
      ask: "Which motor is in this unit?",
      answers: [
        { label: "PSC (has a capacitor)", to: "28h" },
        { label: "ECM or X13 (no capacitor)", to: "28k" },
      ],
      updated: "New. Most furnaces built since 2019 have ECM blower motors. 2014 only covered PSC.",
    },
    {
      id: "28h", type: "check", title: "Power out to the PSC motor",
      tasks: [{ "split-gas": "Test for line voltage between Neutral (or L2) and the COOL / HEAT-COOL / HIGH terminal the motor's speed wire is on.", all: "Test for line voltage between L2 (COM) and the COOL / HIGH terminal the motor's speed wire is on." }],
      ask: "Is the board sending line voltage to the motor?",
      answers: [
        { label: "No", to: "29" },
        { label: "Yes, it has power but doesn't run", to: "28i" },
      ],
    },
    {
      id: "28i", type: "check", title: "Test the blower capacitor",
      tasks: [
        "Kill the power. Discharge the capacitor and remove its wires.",
        "Test it in µF and compare to the rating on the can.",
      ],
      ask: "Does it test within tolerance?",
      answers: [
        { label: "No", to: "4" },
        { label: "Yes, the capacitor is good", to: "31" },
      ],
    },
    {
      id: "28k", type: "check", title: "Check the ECM motor", isNew: true,
      tasks: [
        "Power plug (usually 5 pins): test for line voltage. It should be there all the time, call or no call.",
        "Signal: an X13 motor gets 24 V on one speed tap (to C). A full variable-speed motor gets its signal from the board on a 16-pin plug. Use the manufacturer's procedure or an ECM tester.",
        "Power and signal present but the motor won't run means the motor or its module has failed.",
      ],
      ask: "What did you find?",
      answers: [
        { label: "Power and signal are there, motor won't run", to: "31" },
        { label: "No line voltage at the power plug", to: "33" },
        { label: "No 24 V signal from the board", to: "29" },
      ],
      updated: "New step.",
    },

    // ───────────────────── Indoor repairs ─────────────────────
    {
      id: "29", type: "fix", title: "Replace the control board",
      diagnosis: "You have a bad control board.",
      parts: PARTS_RULE,
      warn: [POWER_OFF],
      tasks: [
        "Photograph the board from every angle, plus the model and serial plate.",
        { all: "Get the replacement board. A universal board works: set it up to match the old one.", inverter: "Get the exact OEM board for the model and serial number." },
        "Unplug the harness plugs. They only fit one way.",
        "Unclip the board from its standoffs, leaving the wires on so it hangs free.",
        "Move one wire at a time from the old board to the same terminal on the new one.",
        { all: "Set any DIP switches, jumpers and blower settings to match the old board.", hp: "Set any DIP switches, jumpers and settings to match the old board. On a defrost board that includes the defrost interval and the compressor delay." },
        "Before powering up, ask why it failed. Look for a shorted part or burnt wire.",
      ],
      answers: [{ label: "Board replaced. Run the end test", to: "end" }],
      updated: "Added DIP switch settings and looking for the cause.",
    },
    {
      id: "30", type: "fix", title: "Replace the transformer",
      diagnosis: "You have a bad transformer.",
      parts: PARTS_RULE,
      intro: "Transformers rarely fail on their own. A blown one usually means a short, or two wires got crossed during other work.",
      warn: [POWER_OFF],
      tasks: [
        "Unscrew the old transformer and let it hang by its wires.",
        { "split-gas": "Mount the new one. Match the primary voltage (120 V furnace, 240 V air handler) and use the same VA rating or higher.", all: "Mount the new one. Match the primary voltage (usually 208/240 V; use the tap that matches your measured voltage) and use the same VA rating or higher." },
        "Connect the primary leads to the new transformer's primary (check its label for colors and taps) with new wire nuts.",
        "Connect the 24 V leads to the new transformer's secondary.",
        "Clamp one 24 V secondary wire and restore power. A 40 VA transformer supplies about 1.6 A (VA ÷ 24). Near that or over means there's still a short.",
      ],
      notes: ["Overloaded? Remove one thermostat wire at a time until the amps drop to find the shorted circuit."],
      answers: [
        { label: "Replaced and under its rating. Run the end test", to: "end" },
        { label: "Still pulling too much. Find the short", to: "26" },
      ],
      updated: "2014 clamped the high-voltage side with a 1 A limit. Now clamps the 24 V side against the transformer's VA rating.",
    },
    {
      id: "31", type: "fix", title: "Replace the blower motor",
      diagnosis: "You have a bad blower motor.",
      parts: PARTS_RULE,
      warn: [POWER_OFF],
      tasks: [
        "Move anything in the way (board, flue pipe, door switch), leaving the wires attached.",
        { all: "Disconnect the motor wires and remove the blower housing, usually two 5/16 in. screws. Take it somewhere you can work.", pkg: "Disconnect the motor wires and slide the blower assembly out of the blower compartment. Take it somewhere you can work." },
        "Loosen the wheel set screw. Sand the shaft and spray it with penetrating oil.",
        "Remove the motor mount bolts and pull the motor out of the wheel. Use a wheel puller if it's stuck. Replace the wheel if it's damaged.",
        "Move the mounting bracket to the new motor at the same spot on the shaft.",
        "PSC: install a new run capacitor sized for the new motor.",
        { all: "ECM: a universal ECM replacement works. Set its speed taps or programming to match the old motor.", inverter: "ECM: use the exact OEM motor or module, programmed for this model." },
        "Install the motor, center the wheel in the housing, and tighten the set screw on the flat plus a quarter turn. Spin it by hand: no rubbing, no wobble.",
        "Reinstall the housing and everything you moved.",
        { "split-gas": "PSC wiring: white to Neutral, heating speed to HEAT, cooling speed to COOL. Park unused taps on the dummy terminals.", all: "PSC wiring: common lead to L2 (COM), cooling speed to COOL or HIGH. Park unused taps on the dummy terminals." },
        "Clamp the motor power lead, close the door and run in cooling. Check amps and rotation.",
      ],
      notes: ["Over nameplate amps? Check the speed tap, the filter and the static pressure before deciding the motor is too small."],
      answers: [{ label: "Motor replaced. Run the end test", to: "end" }],
      updated: "Added ECM motors and modules. Over-amping now points to speed tap, filter and static first, not straight to 'install a bigger motor'.",
    },
    {
      id: "32", type: "fix", title: "Replace the thermostat",
      diagnosis: "You have a bad thermostat, or it's set up wrong.",
      parts: { single: "A universal single-stage thermostat is fine.", two: "A universal two-stage thermostat is fine with conventional wiring (R, W, Y, G, B, C).", inverter: "Inverter or communicating system: use the manufacturer's communicating thermostat." },
      tasks: [
        "Kill the power to the indoor unit.",
        "Photograph the wiring before you remove the old thermostat.",
        { all: "Common colors: R red (24 V), C blue or black (common), Y yellow (cooling), G green (fan), W white (heat). Always follow what's actually wired.", hp: "Common heat pump colors: R red (24 V), C blue or black (common), Y yellow (compressor), G green (fan), O/B orange (reversing valve), W2/AUX white (heat strips). Always follow what's actually wired." },
        { hp: { o: "Set the thermostat to heat pump, reversing valve O (energized in cooling). A wrong O/B setting makes it heat when it should cool.",
                b: "Set the thermostat to heat pump, reversing valve B (energized in heating). A wrong O/B setting makes it heat when it should cool." } },
        "Smart and Wi-Fi thermostats need a C wire. No C? Use a spare conductor or the manufacturer's adapter.",
        "Mount the base level and land each wire on the same terminal as before.",
        "Restore power. Set the system type in the thermostat's setup, then set Cool, fan Auto, 60°F.",
      ],
      answers: [{ label: "Thermostat replaced or set up. Run the end test", to: "end" }],
      updated: "Added the C wire and smart thermostat setup. Heat pump: O/B wire and setting.",
    },
    {
      id: "33", type: "fix", title: { all: "Find power to the {indoor}", pkg: "Find power inside the unit" },
      diagnosis: { all: "No line voltage is reaching the {indoor}.", pkg: "Line voltage isn't reaching the board or blower inside the unit." },
      tasks: [
        { "split-gas": "Check that the service switch at the unit is on.", "split-hp": "Check the air handler's breaker or disconnect, and any breakers built into the heat strip kit." },
        { all: "Test for line voltage at the unit's power splices. If it's there, the wiring between the splices and the board is bad.", pkg: "A package unit gets all its power from one disconnect. Test for line voltage at the unit's power terminal block." },
        { all: "Not there? Test the service switch. Power in but not out means a bad switch.", pkg: "Power at the terminal block? Follow it to the transformer and blower. Look for a blown inline fuse, a tripped limit or rollout switch on a gas pack, or a burnt wire." },
        { all: "Nothing at the switch? Test at the breaker. Turn it fully off, then back on.", pkg: "Nothing at the terminal block? Trace it back through the disconnect (Step 7B)." },
        { all: "Breaker trips again, won't pass power, or power leaves the breaker but never arrives: call a licensed electrician.", pkg: "Breaker trips again, or power leaves the breaker but never arrives: call a licensed electrician." },
      ],
      answers: [
        { label: "Power restored. Restart the matrix", to: "1" },
        { label: { pkg: "No power coming into the unit" }, to: "7" },
      ],
      updated: "Added air handlers (208–240 V). Package: one disconnect feeds the whole unit.",
    },
    {
      id: "34", type: "fix", title: "Replace the contactor",
      diagnosis: "You have a bad contactor.",
      parts: PARTS_RULE,
      warn: [POWER_OFF],
      tasks: [
        "Match the new contactor's coil voltage (24 V), pole count and amp rating.",
        "Unmount the old contactor and pull it out with the wires still on. Mount the new one in the same spot.",
        "Move one wire at a time from the old contactor to the same terminal on the new one.",
        "Check every connection is tight and nothing is touching that shouldn't be.",
        "Start the unit with your amp clamp on the compressor common.",
      ],
      notes: ["Pitted, burnt contacts damage compressors. Always replace the contactor with a compressor."],
      ask: "How did it start?",
      answers: [
        { label: "Clean start. Run the end test", to: "end" },
        { label: "Hung near LRA or struggled", to: "16" },
      ],
      updated: "'Over 30 amps' rule replaced with nameplate LRA.",
    },
    {
      id: "35", type: "fix", title: "Clear the condensate drain", isNew: true,
      diagnosis: "A float switch tripped. The condensate drain is backed up.",
      warn: [POWER_OFF],
      tasks: [
        "Empty the water from the pan.",
        { all: "Clear the drain line: vacuum it from the outlet end, or flush it from the cleanout tee.", pkg: "Clear the unit's drain outlet and P-trap. Package units need a trap on the drain, or the blower holds the water in the pan." },
        { all: "Check the trap, the slope (at least 1/4 inch per foot), and that the secondary pan has its own drain.", pkg: "Check the drain runs downhill from the unit and the trap is primed." },
        "Pour water into the pan and confirm it drains freely.",
        "Make sure the float switch resets and is level and secure.",
      ],
      notes: ["Lots of water can also mean a frozen coil that's melting. If so, find out why it froze (Step 20)."],
      answers: [{ label: "Drain is clear. Restart the matrix", to: "1" }],
    },
    {
      id: "36", type: "fix", title: "A2L leak detection lockout", isNew: true,
      diagnosis: "The refrigerant detection system has shut down cooling.",
      intro: "R-454B and R-32 systems have a refrigerant sensor in the indoor section. When it detects refrigerant or has a fault, it stops the compressor and runs the blower to clear the air.",
      warn: ["Treat a leak alarm as real until proven otherwise. Ventilate the space, keep flames and sparks away, and use an A2L-rated leak detector."],
      tasks: [
        "Read the detection board's LED or fault code against the manufacturer's chart.",
        "Leak detected: confirm it with an A2L-rated electronic leak detector at the indoor coil and line set.",
        "Sensor fault, unplugged sensor or expired sensor: reseat the connector or replace the sensor with the OEM part.",
        "After the repair, clear the alarm the way the manufacturer specifies and confirm the board is back to normal.",
      ],
      answers: [
        { label: "Leak confirmed. Find and fix it", to: "21" },
        { label: "Sensor or wiring fixed. Restart the matrix", to: "1" },
      ],
    },
    {
      id: "37", type: "fix", title: "Fix the airflow problem", isNew: true,
      diagnosis: "Not enough air is moving across the indoor coil.",
      tasks: [
        "Replace a dirty filter. Check it's the right size and air can't sneak around it.",
        "Clean a dirty blower wheel.",
        { all: "Repair crushed or kinked ducts. Pull out any insulation or debris clogging a duct.", pkg: "Repair crushed duct and seal the duct connections at the roof curb or wall. Pull out any debris clogging a duct." },
        "Open closed dampers and clear blocked returns and registers.",
        "Check the blower is set to the cooling speed, typically 350–400 CFM per ton.",
        "Re-check static pressure against the unit's rating.",
      ],
      answers: [
        { label: "Airflow fixed. Check static again, then the pressures", to: "sp" },
        { label: "Airflow fixed. Run the end test", to: "end" },
      ],
    },

    // ───────────────────── Heat pump: reversing valve ─────────────────────
    {
      id: "rv", systems: ["hp"], type: "check", title: "Check the reversing valve", isNew: true,
      intro: "In cooling, the reversing valve sends hot gas to the outdoor coil. Stuck in heat, it heats the house. Leaking through, it pumps hot gas straight back to the compressor: high suction, low head.",
      tool: "rvmode",
      tasks: [
        { o: "Check the thermostat is set up as a heat pump with reversing valve O.", b: "Check the thermostat is set up as a heat pump with reversing valve B." },
        { o: "During a cooling call, test for 24 V at the reversing valve coil at the {outdoor}. It should be there.",
          b: "During a cooling call, test the reversing valve coil at the {outdoor}. It should have no voltage: a B valve rests in cooling." },
        { o: "No 24 V at the coil? Test O to C at the thermostat to see if the call leaves the thermostat." },
        { o: "Power off: check the coil's resistance. No reading means an open coil." },
        { o: "With 24 V on a good coil, the valve should shift with a click, and the large line should go cold within a minute or two.",
          b: "With the coil de-energized, the valve should sit in cooling, and the large line should go cold within a minute or two." },
        "Running in cooling, feel the valve's tubes. The tube to the compressor suction should be cold. A hot or warm suction tube at the valve means it's leaking through.",
      ],
      notes: [{ b: "On a B system an open coil stops heating, not cooling. Note it for the customer, but it isn't your cooling problem." }],
      ask: "What did you find?",
      answers: [
        { label: { o: "No 24 V at the coil, and none on O at the thermostat" }, to: "32" },
        { label: { o: "24 V on O at the thermostat, but not at the coil" }, to: "11w" },
        { label: { o: "24 V at the coil, but the coil reads open" }, to: "rvc" },
        { label: { b: "24 V on the coil during cooling" }, to: "32" },
        { label: { o: "Coil good and powered, but the valve won't shift or leaks through", b: "Coil de-energized, but the valve is stuck in heat or leaks through" }, to: "rvv" },
        { label: "The valve shifts and seals fine", to: "22" },
      ],
      updated: "New. Heat pump only. Assumes O (energized in cooling) unless the tech switches to B.",
    },
    {
      id: "rvc", systems: ["hp"], type: "fix", title: "Replace the reversing valve coil", isNew: true,
      diagnosis: "The reversing valve coil is bad.",
      parts: PARTS_RULE,
      warn: [POWER_OFF],
      tasks: [
        "Remove the coil's retaining nut or clip and slide the coil off the valve's pilot stem.",
        "Match the replacement to the old coil: 24 V, same manufacturer part or an approved universal coil.",
        "Slide the new coil on, secure it, and reconnect its two wires.",
        "Restore power and run in cooling. The valve should click over and the large line should go cold.",
      ],
      answers: [{ label: "Coil replaced. Run the end test", to: "end" }],
    },
    {
      id: "rvv", systems: ["hp"], type: "fix", title: "Replace the reversing valve", isNew: true,
      diagnosis: "The reversing valve is stuck or leaking through.",
      parts: PARTS_RULE,
      warn: [A2L_WARN],
      tasks: [
        "Try to free it first: with the unit running, switch between heat and cool a few times. Tap the valve body lightly with a rubber mallet, never the tubes.",
        "Still stuck or leaking through? Recover the charge.",
        "Unbraze the old valve's four joints, flowing nitrogen.",
        "Wrap the new valve's body in a wet rag or heat-sink paste. The slide inside is damaged by heat.",
        "Braze in the new valve, flowing nitrogen, heating the joints and not the body. Keep the body cool the whole time.",
        "Replace the drier with a bi-flow drier.",
      ],
      answers: [{ label: "Valve replaced. Evacuate and charge", to: "9" }],
    },

    // ───────────────────── Finish ─────────────────────
    {
      id: "end", type: "end", title: "End test: temperature split",
      tasks: [
        "Let the system run at least 15 minutes.",
        "Measure the return air temperature within a few feet of the return grille.",
        "Measure the supply air temperature at the nearest supply register.",
      ],
      tool: "split",
      notes: [
        "Target: 18–25°F cooler at the supply than the return in dry climates.",
        "Humid conditions, or a variable-speed system on low stage, can read a few degrees lower and still be fine.",
      ],
      ask: "Is your temperature split in range?",
      answers: [
        { label: "Yes, it's in range", to: "done", match: ["normal"] },
        { label: "No, 17°F or less. Restart the matrix", to: "1", match: ["low"] },
      ],
      updated: "Kept the 18–25°F target. Added the note about humid conditions and variable-speed systems.",
    },
    {
      id: "done", type: "done", title: "Fixed",
      tasks: [
        "Pick up every tool. Nothing left in the unit.",
        "All panels and screws back in.",
        "Disconnect in, breaker on, fuses in, service switches on.",
        "Thermostat back to the customer's setting.",
      ],
    },
  ],
};
