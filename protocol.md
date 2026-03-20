Go to the first, previous, next, last section, table of contents.

13 Binary monitor
The binary remote monitor commands are sent over a dedicated connection, specified with the command line options -binarymonitor & -binarymonitoraddress. See section 6.17 Monitor settings. The remote monitor detects a binary command because it starts with ASCII STX (0x02). Note that there is no termination character. The command length acts as synchronisation point.

All multibyte values are in little endian order unless otherwise specified.

13.1 Command Structure
byte 0: 0x02 (STX)
byte 1: API version ID (currently 0x02)
The API version identifies incompatible changes, such as modifying the header structure, or rearranging or changing the meaning of existing response fields. The API version does not need to be incremented for additional fields. If all the variable length fields are prefixed with their lengths then you should be able to add new ones to any response. The server can assume default values for older clients, and for newer clients with longer commands it should be able to ignore the extra fields safely.
byte 2-5: length
Note that the command length does *not* count the STX, the command length, the command byte, or the request ID. Basically nothing in the header, just the body.
byte 6-9: request id
In little endian order. All multibyte values are in little endian order, unless otherwise specified. There is no requirement for this to be unique, but it makes it easier to match up the responses if you do.
byte 10: The numeric command type
See section 13.4 Commands.
byte 11+: The command body.
See section 13.4 Commands.
13.2 Response Structure
byte 0: 0x02 (STX)
byte 1: API version ID (currently 0x02)
The API version identifies incompatible changes, such as modifying the header structure, or rearranging or changing the meaning of existing response fields. The API version does not need to be incremented for additional fields. If all the variable length fields are prefixed with their lengths then you should be able to add new ones to any response. The client can assume default values for older versions of VICE, and for newer versions of VICE with longer responses it should be able to ignore the extra fields safely.
byte 2-5: response body length. Does not include any header fields
byte 6: response type
This is usually the same as the command ID
byte 7: error code
0x00
OK, everything worked
0x01
The object you are trying to get or set doesn't exist.
0x02
The memspace is invalid
0x80
Command length is not correct for this command
0x81
An invalid parameter value was present
0x82
The API version is not understood by the server
0x83
The command type is not understood by the server
0x8f
The command had parameter values that passed basic checks, but a general failure occurred

See section 13.4 Commands for other error codes
byte 8-11: request ID
This is the request ID given to initiate this response. If the value is 0xffffffff, Then the response was initiated by an event, such as hitting a checkpoint.
byte 12+: response body.
See section 13.4 Commands.
13.3 Example Exchange
Client connects to ip4://127.0.0.1:6502
Client sends a command to set a temporary checkpoint:

02 | 02 | 08 00 00 00 | ad de 34 12 | 12 | e2 fc | e3 fc | 01 | 01 | 04 | 01

0x02
Begin command
0x02
API version 2
0x00000008
The command excluding the header is 8 bytes long.
0x1234dead
The request ID is 0x1234dead. The response will contain this ID.
0x12
See section 13.4.4 Checkpoint set (0x12).
0xfce2
The address range of the checkpoint starts at 0xfce2.
0xfce3
The address range of the checkpoint ends at 0xfce3.
0x01
The checkpoint will cause the emulator to stop.
0x01
The checkpoint is enabled.
0x04
The checkpoint will trigger on exec from 0xfce2 - 0xfce3.
0x01
The checkpoint is temporary.
The transmission of any command causes the emulator to stop, similar to the regular monitor. This causes the server to respond with a list of register values.

02 | 02 | 26 00 00 00 | 31 | 00 | ff ff ff ff | 09 00 [ 03 { 03 | cf e5 } 03 { 00 | 00 00 } ... ]

0x02
Begin response
0x02
API Version 2
0x00000026
Response length is 38
0x31
See section 13.5.3 Register Response (0x31).
0x00
No error occurred
0xffffffff
This response was not directly triggered by a command from the client.
0x0009
The register array is 9 items long
PC:
0x03
The register array item is 3 bytes long
0x03
The register is the PC (ID 3) Note: you should find the names to these IDs using the MON_CMD_REGISTERS_AVAILABLE command. See section 13.4.20 Registers available (0x83). Do not rely on them being consistent.
0xe5cf
The register value is 0xe5cf
A:
0x03
The register array item is 3 bytes long
0x00
The register is A (ID 0) Note: you should find the names to these IDs using the MON_CMD_REGISTERS_AVAILABLE command. See section 13.4.20 Registers available (0x83). Do not rely on them being consistent.
0x0000
The register value is 0x0000
After the register information, the server sends a stopped event to indicate that the emulator is stopped.

02 | 02 | 02 00 00 00 | 62 | 00 | ff ff ff ff | cf e5

0x02
Begin response
0x02
API Version 2
0x00000002
Response is two bytes long.
0x62
Response type is 0x62, MON_RESPONSE_STOPPED.
0xffffffff
This response was not directly triggered by a command from the client.
0xe5cf
The current program counter
The server processes the checkpoint set command, and sends a response to the client.

... | 11 | ... | 02 00 00 00 | 00 | e2 fc | e3 fc | 01 | 01 | 04 | 01 | 00 00 00 00 | 00 00 00 00 | 00
(Some response header fields are omitted (...) for brevity.)

0x11
See section 13.5.2 Checkpoint Response (0x11).
0x00000002
Checkpoint number is 2
0x00
Checkpoint was not hit (as it was just created)
0xfce2
Checkpoint start address
0xfce3
Checkpoint end address
0x01
The checkpoint will cause the emulator to stop.
0x01
The checkpoint is enabled.
0x04
The checkpoint will trigger on exec from 0xfce2 - 0xfce3.
0x01
The checkpoint is temporary.
0x00000000
The checkpoint has been hit zero times.
0x00000000
The checkpoint has been ignored zero times.
Client sends a command to continue:

... | aa
(Some command header fields are omitted (...) for brevity.)

0xaa
See section 13.4.27 Exit (0xaa).
Server acknowledges the command:

... | aa | ...
(Some response header fields are omitted (...) for brevity.)

0xaa
See section 13.4.27 Exit (0xaa).
Server resumes execution and sends a resume event:

... | 63 | ... | cf e5
(Some response header fields are omitted (...) for brevity.)

0x63
See section 13.5.6 Resumed Response (0x63).
0xe5cf
Program counter is currently at 0xe5cf
Some time later, the server hits the breakpoint. This causes it to emit a checkpoint response. This is identical to the previous checkpoint response, except that it is marked as "hit" and the hit and ignore counts are updated.
The server emits the register information and the stopped event when reentering the monitor, as seen previously.
13.4 Commands
These are the possible command types and responses, without the header portions mentioned above.

13.4.1 Memory get (0x01)
Reads a chunk of memory from a start address to an end address (inclusive).

Minimum VICE version: 3.5

Command body:

FX | SA SA | EA EA | MS | BI BI


FX: 1 byte: side effects?
Should the read cause side effects?
SA: 2 bytes: start address
EA: 2 bytes: end address
MS: 1 byte: memspace
Describes which part of the computer you want to read:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
BI: 2 bytes: bank ID
Describes which bank you want. This is dependent on your machine. See section 13.4.19 Banks available (0x82). If the memspace selected doesn't support banks, this value is ignored.
Response type:

0x01: MON_RESPONSE_MEM_GET

Response body:

ML ML | MM[0] MM[1] ... MM[ML-1]


ML: 2 bytes: Memory segment length.
Will be zero for start 0x0000, end 0xffff.
MM: ML bytes: The memory at the address.
13.4.2 Memory set (0x02)
Writes a chunk of memory from a start address to an end address (inclusive).

Minimum VICE version: 3.5

Command body:

FX | SA SA | EA EA | MS | BI BI | MM[0] MM[1] ... MM[EA-SA]


FX: 1 byte: side effects?
Should the write cause side effects?
SA: 2 bytes: start address
EA: 2 bytes: end address
MS: 1 byte: memspace
Describes which part of the computer you want to write:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
BI: 2 bytes: bank ID
Describes which bank you want. This is dependent on your machine. See section 13.4.19 Banks available (0x82). If the memspace selected doesn't support banks, this byte is ignored.
MM: 1+EA-SA bytes: Memory contents to write
Response type:

0x02: MON_RESPONSE_MEM_SET

Response body:

Currently empty.


13.4.3 Checkpoint get (0x11)
Gets any type of checkpoint. (break, watch, trace)

Minimum VICE version: 3.5

Command body:

CN CN CN CN


CN: 4 bytes: checkpoint number
See section 13.5.2 Checkpoint Response (0x11).

13.4.4 Checkpoint set (0x12)
Sets any type of checkpoint. This combines the functionality of several textual commands (break, watch, trace) into one, as they are all the same with only minor variations. To set conditions, see section 13.4.8 Condition set (0x22) after executing this one.

Command body:

SA SA | EA EA | ST | EN | OP | TM | MS?


SA: 2 bytes: start address
EA: 2 bytes: end address
ST: 1 byte: stop when hit
>=0x01: true, 0x00: false
EN: 1 byte: enabled
>=0x01: true, 0x00: false
OP: 1 byte: CPU operation
>=0x01: load, 0x02: store, 0x04: exec
TM: 1 byte: temporary
Deletes the checkpoint after it has been hit once. This is similar to "until" command, but it will not resume the emulator.
MS: 1 byte (optional): memspace
Describes which part of the computer to checkpoint:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
See section 13.5.2 Checkpoint Response (0x11).

13.4.5 Checkpoint delete (0x13)
Deletes any type of checkpoint. (break, watch, trace)

Minimum VICE version: 3.5

Command body:

CN CN CN CN


CN: 4 bytes: checkpoint number
Response type:

0x13: MON_RESPONSE_CHECKPOINT_DELETE

Response body:

Currently empty.


13.4.6 Checkpoint list (0x14)
Minimum VICE version: 3.5

Command body:

Currently empty.


Response type:

Emits a series of MON_RESPONSE_CHECKPOINT_INFO responses (see section 13.5.2 Checkpoint Response (0x11)) followed by

0x14: MON_RESPONSE_CHECKPOINT_LIST

Response body:

CC CC CC CC


CC: 4 bytes: The total count of checkpoints
13.4.7 Checkpoint toggle (0x15)
Minimum VICE version: 3.5

Command body:

CN CN CN CN | EN


CN: 4 bytes: Checkpoint number
EN: 1 byte: Enabled?
0x00: disabled, 0x01: enabled
Response type:

0x15: MON_RESPONSE_CHECKPOINT_TOGGLE

Response body:

Currently empty.


13.4.8 Condition set (0x22)
Sets a condition on an existing checkpoint. It is not currently possible to retrieve conditions after setting them.

Minimum VICE version: 3.5

Command body:

CN CN CN CN | EL | ES[0] ES[1] ... ES[EL-1]


CN: 4 bytes: checkpoint number
EL: 1 byte: condition expression length
ES: EL bytes: condition expression string
This is the same format used in the text monitor. Not null terminated.
Response type:

0x22: MON_RESPONSE_CONDITION_SET

Response body:

Currently empty.


13.4.9 Registers get (0x31)
Get details about the registers

Minimum VICE version: 3.5

Command body:

MS


MS: 1 byte: memspace
Describes which part of the computer you want to read:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
See section 13.5.3 Register Response (0x31).

13.4.10 Registers set (0x32)
Set the register values

Minimum VICE version: 3.5

Command body:

MS | RC RC [
    IS[0] { RI[0] | RV[0] RV[0] }
    ...
    IS[RC-1] { RI[RC-1] | RV[RC-1] RV[RC-1] }
]


MS: 1 byte: memspace
Describes which part of the computer you want to write:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
RC: 2 bytes: Register count
Array: RC*(IS+1) bytes: An array with items of structure:
[
IS: 1 byte: Item size, excluding this byte
RI: 1 byte: Register ID
RV: 2 bytes: Register value
]
See section 13.5.3 Register Response (0x31).

13.4.11 Dump (0x41)
Saves the machine state to a file.

Minimum VICE version: 3.5

Command body:

SR | SD | FL | FN[0] FN[1] ... FN[FL-1]


SR: 1 byte: Save ROMs to snapshot file?
>=0x01: true, 0x00: false
SD: 1 byte: Save disks to snapshot file?
>=0x01: true, 0x00: false
FL: 1 byte: Length of filename
FN: FL bytes: Filename
The filename to save the snapshot to.
Response type:

0x41: MON_RESPONSE_DUMP

Response body:

Currently empty.


13.4.12 Undump (0x42)
Loads the machine state from a file.

Minimum VICE version: 3.5

Command body:

FL | FN[0] FN[1] ... FN[FL-1]


FL: 1 byte: Length of filename
FN: FL bytes: Filename
The filename to load the snapshot from.
Response type:

0x42: MON_RESPONSE_UNDUMP

Response body:

PC PC


PC: 2 bytes: The current program counter position
13.4.13 Resource Get (0x51)
Get a resource value from the emulator. See section 6.1 Format of resource files.

Minimum VICE version: 3.5

Command body:

NL | RN[0] RN[1] ... RN[NL-1]


NL: 1 byte: Resource name length
RN: NL bytes: Resource name
Response type:

0x51: MON_RESPONSE_RESOURCE_GET

Response body:

RT | VL | RV[0] RV[1] ... RV[VL-1]


RT: 1 byte: Resource type
0x00: String, 0x01: Integer
VL: 1 byte: Resource value length
RV: VL bytes: The resource value
13.4.14 Resource Set (0x52)
Set a resource value in the emulator. See section 6.1 Format of resource files.

Minimum VICE version: 3.5

Command body:

RT | NL | RN[0] RN[1] ... RN[NL-1] | VL | RV[0] RV[1] ... RV[VL-1]


RT: 1 byte: Type of the resource value
0x00: String, 0x01: Integer
Strings will be interpreted if the destination is an Integer.
NL: 1 byte: Resource name length
RN: NL bytes: The resource name
VL: 1 byte: Resource value length
RV: VL bytes: The resource value
Response type:

0x52: MON_RESPONSE_RESOURCE_SET

Response body:

Currently empty.


13.4.15 Advance Instructions (0x71)
Step over a certain number of instructions.

Minimum VICE version: 3.5

Command body:

SO | IC IC


SO: 1 byte: Step over subroutines?
Should subroutines count as a single instruction?
IC: 2 bytes: How many instructions to step over.
Response type:

0x71: MON_RESPONSE_ADVANCE_INSTRUCTIONS

Response body:

Currently empty.


13.4.16 Keyboard feed (0x72)
Add text to the keyboard buffer.

Minimum VICE version: 3.5

Minimum API version: 2

Command body:

TL | TC[0] TC[1] ... TC[TL-1]


TL: 1 byte: Text Length
TC: TL bytes: The text content, in PETSCII
Response type:

0x72: MON_RESPONSE_KEYBOARD_FEED

Response body:

Currently empty.


13.4.17 Execute until return (0x73)
Continues execution and returns to the monitor just after the next RTS or RTI is executed.

This command is the same as "return" in the text monitor.

Minimum VICE version: 3.5

Command body:

Currently empty.


Response type:

0x73: MON_RESPONSE_EXECUTE_UNTIL_RETURN

Response body:

Currently empty.


13.4.18 Ping (0x81)
Get an empty response

Minimum VICE version: 3.5

Command body:

Always empty


Response type:

0x81: MON_RESPONSE_PING

Response body:

Always empty


13.4.19 Banks available (0x82)
Gives a listing of all the bank IDs for the running machine with their names.

Minimum VICE version: 3.5

Command body:

Currently empty.


Response type:

0x82: MON_RESPONSE_BANKS_AVAILABLE

Response body:

BC BC [ 
    IS[0] { BI[0] BI[0] | NL[0] | BN[0][0] BN[0][1] ... BN[0][NL[0]-1] }
    ... 
    IS[BC-1] { ... }
]


BC: 2 bytes: Bank item count
Array 1+BC*IS bytes: An array with items of structure:
[
IS: 1 byte: Item size, excluding this byte
BI: 2 bytes: Bank ID
NL: 1 byte: Name Length
BN: NL bytes: Name
]
13.4.20 Registers available (0x83)
Gives a listing of all the registers for the running machine with their names.

Minimum VICE version: 3.5

Command body:

MS


MS: 1 byte: memspace
Describes which part of the computer you want to read:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
Response type:

0x83: MON_RESPONSE_REGISTERS_AVAILABLE

Response body:

RC RC [ IS[0] { RI[0] | RS[0] | NL[0] | RN[0][0] RN[0][1] ... RN[0][NL[0]-1] } ... IS[RC-1] { ... } ]


RC: 2 bytes: Register item count
Array: RC*(IS+1) bytes: An array with items of structure:
IS: 1 byte: Item Size, excluding this byte
RI: 1 byte: Register ID
RS: 1 byte: Register Size in bits
NL: 1 byte: Length of name
RN: NL bytes : Register name
13.4.21 Display Get (0x84)
Gets the current screen in a requested bit format.

Minimum VICE version: 3.5

Minimum API version: 2

Command body:

VC | FM


VC: 1 byte: USE VIC-II?
Must be included, but ignored for all but the C128. If true, (>=0x01) the screen returned will be from the VIC-II. If false (0x00), it will be from the VDC.
FM: 1 byte: Format
0x00: Indexed, 8 bit
Response type:

0x84: MON_RESPONSE_DISPLAY_GET

Response body:

FL FL FL FL | DW DW | DH DH | XO XO | YO YO | IW IW | IH IH | BP | 
    BL BL BL BL | BD[0] BD[1] ... BD[BL-1]


FL: 4 bytes: Length of the fields before the display buffer
DW: 2 bytes: Debug width of display buffer (uncropped)
The largest width the screen gets.
DH: 2 bytes: Debug height of display buffer (uncropped)
The largest height the screen gets.
XO: 2 bytes: X offset
X offset to the inner part of the screen.
YO: 2 bytes: Y offset
Y offset to the inner part of the screen.
IW: 2 bytes: Width of the inner part of the screen.
IH: 2 bytes: Height of the inner part of the screen.
BP: 1 byte: Bits per pixel of display buffer, 8
BL: 4 bytes: Length of display buffer
BD: BL bytes: Display buffer data
13.4.22 VICE info (0x85)
Get general information about VICE. Currently returns the versions.

Minimum VICE version: 3.6

Command body:

Always empty


Response type:

0x85: MON_RESPONSE_VICE_INFO

Response body:

ML | MV[0] MV[1] ... MV[ML-1] | SL | SV[0] SV[1] ... SV[SL-1]


ML: 1 byte: Length of main version
MV: ML bytes: Main version
In linear format. For example 0x03, 0x05, 0x00, 0x00 for 3.5.0.0
SL: 1 byte: Length of SVN revision
SV: SL bytes: SVN revision
In little endian format. Returns zero if it's not an SVN build.
13.4.23 CPU History (0x86)
Gets records of every instruction executed by an emulated CPU.

Minimum VICE version: 3.10

Command body:

MS | HC HC HC HC


MS: 1 byte: memspace
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
HC: 4 bytes: count of items to retrieve
Response type:

0x86: MON_RESPONSE_CPUHISTORY_GET

Response body:

HC HC HC HC [
    IS[0] {
      RC[0] RC[0] [
        RS[0][0] { ... }
        ...
        RS[0][RC-1] { ... }
      ]
      CL[0] CL[0] CL[0] CL[0] CL[0] CL[0] CL[0] CL[0] | IL[0] | IB[0][0] IB[0][1] ... IB[0][IL-1]
    }
    ...
    IS[HC-1] { ... }
]


HC: 4 bytes: CPU history item count
Array: HC*(IS+1) bytes:
An array with items of structure:
[
IS: 1 bytes: Item size, excluding this byte
RC: 2 bytes: Register item count
Array: RC*(RS+1) bytes: Array items of structure:
[
RS: 1 byte: Item size, excluding this byte
{...}: RS bytes: The array item body from section 13.5.3 Register Response (0x31)
]
CL: 8 bytes: The CPU clock
IL: 1 bytes: instruction bytes length
IB: IL bytes: Instruction byte string.
This is a fixed length and must be interpreted by the client.
]
13.4.24 Palette get (0x91)
Get the colors in the current palette

Minimum VICE version: 3.6

Command body:

VC


VC: 1 byte: USE VIC-II?
Must be included, but ignored for all but the C128. If true, (>=0x01) the screen returned will be from the VIC-II. If false (0x00), it will be from the VDC.
Response type:

0x91: MON_RESPONSE_PALETTE_GET

Response body:

PC PC [
  IS[0] { RR[0] | GG[0] | BB[0] }
  ...
  IS[PC-1] { RR[PC-1] | GG[PC-1] | BB[PC-1] }
]


PC: 2 bytes: The palette item count
Array : PC*(IS+1): An array with items of structure:
[
IS: 1 byte: Item size, excluding this byte
RR: 1 byte: Red
GG: 1 byte: Green
BB: 1 byte: Blue
]
13.4.25 Joyport set (0xa2)
Set the simulated joyport value.

Minimum VICE version: 3.6

Command body:

PN PN | PV PV


PN: 2 bytes: The port to set the value on
PV: 2 bytes: The value to set
Response type:

0xa2: MON_RESPONSE_JOYPORT_SET

Response body:

Currently empty.


13.4.26 Userport set (0xb2)
Set the simulated userport value.

Minimum VICE version: 3.6

Command body:

UV UV


UV: 2 bytes: The value to set
Response type:

0xb2: MON_RESPONSE_USERPORT_SET

Response body:

Currently empty.


13.4.27 Exit (0xaa)
Exit the monitor until the next breakpoint.

Minimum VICE version: 3.5

Command body:

Currently empty.


Response type:

0xaa: MON_RESPONSE_EXIT

Response body:

Currently empty.


13.4.28 Quit (0xbb)
Quits VICE.

Minimum VICE version: 3.5

Command body:

Currently empty.


Response type:

0xbb: MON_RESPONSE_QUIT

Response body:

Currently empty.


13.4.29 Reset (0xcc)
Reset the system or a drive

Minimum VICE version: 3.5

Command body:

RS


RS: 1 byte: What to reset
0x00: Reset system
0x01: Power cycle system
0x08 - 0x0b: Reset drives 8 - 11
Response type:

0xcc: MON_RESPONSE_RESET

Response body:

Currently empty.


13.4.30 Autostart / autoload (0xdd)
Load a program then return to the monitor

Minimum VICE version: 3.5

Command body:

RL | FI FI | FL | FN[0] FN[1] ... FN[FL-1]


RL: 1 byte: Run after loading?
>=0x01: true, 0x00: false
FI: 2 bytes: File index
The index of the file to execute, if a disk image. 0x00 is the default value.
FL: byte 3: Length of filename
FN: FL bytes: Filename
The filename to autoload.
Response type:

0xdd: MON_RESPONSE_AUTOSTART

Response body:

Currently empty.


13.5 Responses
These responses are generated by many different commands, or by certain events. Events are generated with a request ID of 0xffffffff, so that they can be easily distinguished from regular requests.

13.5.1 Invalid Response (0x00)
This response type is returned for errors.

Response type:

0x00: MON_RESPONSE_INVALID

Response body:

Usually empty


13.5.2 Checkpoint Response (0x11)
This response is generated by hitting a checkpoint, or by many of the checkpoint commands.

See section 13.4.3 Checkpoint get (0x11).

See section 13.4.4 Checkpoint set (0x12).

See section 13.4.6 Checkpoint list (0x14).

Response type:

0x11: MON_RESPONSE_CHECKPOINT_INFO

Response body:

CN CN CN CN | CH | SA SA | EA EA | ST | EN | OP | TM | 
    HC HC HC HC | IC IC IC IC | CE | MS


CN: 4 bytes: Checkpoint number
CH: 1 byte: Currently hit?
>=0x01: true, 0x00: false
SA: 2 bytes: start address
EA: 2 bytes: end address
ST: 1 byte: stop when hit
>=0x01: true, 0x00: false
EN: 1 byte: enabled
>=0x01: true, 0x00: false
OP: 1 byte: CPU operation
0x01: load, 0x02: store, 0x04: exec
TM: 1 byte: temporary
Deletes the checkpoint after it has been hit once. This is similar to "until" command, but it will not resume the emulator.
HC: 4 bytes: hit count
IC: 4 bytes: ignore count
CE: 1 byte: Has condition?
>=0x01: true, 0x00: false
MS: 1 byte: memspace
Describes which part of the computer to checkpoint:
0x00: main memory
0x01: drive 8
0x02: drive 9
0x03: drive 10
0x04: drive 11
13.5.3 Register Response (0x31)
Response type:

0x31: MON_RESPONSE_REGISTER_INFO

Response body:

RC RC [ 
    IS[0] { RI[0] | RV[0] RV[0] }
    ...
    IS[RC-1] { RI[RC-1] | RV[RC-1] RV[RC-1] }
]


RC: 2 bytes: The count of the array items
Array: RC*(IS+1): An array with items of structure:
[
IS: 1 byte: Item size, excluding this byte
RI: 1 byte: ID of the register
RV: 2 bytes: register value
]
13.5.4 JAM Response (0x61)
When the CPU jams

Response type:

0x61: MON_RESPONSE_JAM

Response body:

PC PC


PC: 2 bytes: The current program counter position
13.5.5 Stopped Response (0x62)
When the machine stops for the monitor, either due to hitting a checkpoint or stepping.

Response type:

0x62: MON_RESPONSE_STOPPED

Response body:

PC PC


PC: 2 bytes: The current program counter position
13.5.6 Resumed Response (0x63)
When the machine resumes execution for any reason.

Response type:

0x63: MON_RESPONSE_RESUMED

Response body:

PC PC


PC: 2 bytes: The current program counter position
13.6 Example Projects
Here's a short list of some projects using the binary monitor interface:



https://github.com/GeorgRottensteiner/C64Studio with the VICE binary monitor.
https://github.com/MihaMarkic/vice-bridge-net (GUI).
https://github.com/Sakrac/IceBroLite
https://github.com/empathicqubit/vscode-cc65-debugger assembly code from Visual Studio Code.
https://github.com/rolandshacks/vs64
C64 Studio	IDE for assembly and BASIC projects, geared toward game development.
VICE Binary Monitor Bridge for .NET	A cross platform .NET 5 library that implements a bridge for communication
IceBro Lite	IceBro Lite is a source-level debugger with a graphical user interface
VS65 Debugger	Visual Studio Code extension to debug CC65 projects.
VS64	The VS64 extension makes it easy to build, debug, inspect and run C64
Go to the first, previous, next, last section, table of contents.
