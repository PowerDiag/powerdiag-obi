# OBI Interface Board — design files

`ProDoc_OBI.epro2` is the complete schematic and PCB of the OBI interface board, exported from
**EasyEDA Pro 3.0**. It contains everything shown in the [main README](../README.md#hardware-obi-interface-board):
the Arduino Nano carrier, the Makita LXT connector, the two buttons, the WS2812 status LED and the
pack voltage divider.

## Opening it

Open [EasyEDA Pro](https://pro.easyeda.com/) (version 3.0 or newer) and use
**File → Import → EasyEDA Pro (`.epro2`)**. The standard edition of EasyEDA cannot open this format.

## Buying a kit

If you would rather not order a PCB and source the parts separately, the board and all its
components are sold as a kit on AliExpress — search for **`open battery information`**
([search](https://www.aliexpress.com/wholesale?SearchText=open+battery+information)).

## Building your own

The project is set up so you can have the board made directly:

1. Import the `.epro2` into EasyEDA Pro.
2. Order it from **[JLCPCB](https://jlcpcb.com/)** straight from the editor, or export Gerbers and
   use any other manufacturer.
3. The BOM is an Arduino Nano, a Makita LXT connector, one WS2812 in a 5050 package, two tactile
   switches, four resistors, one zener and one 100 nF capacitor. The Nano, the connector and the
   switches are through-hole; the rest are 0603-and-similar SMD parts, all on the top side. See the
   pin and component tables in the main README.

Feel free to copy, modify or re-spin the board.

## Enclosure

STLs for a printable two-part case are in [`../case/`](../case/).
