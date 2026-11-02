"""Create the Excel fixtures used by excel-import.js (pip install openpyxl)."""
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "Members"; ws.append(["Name", "Phone"])
for i in range(200): ws.append([f"Member {i} Mensah", 233240000000 + i])
for i in range(50): ws.append([f"Ama Ɔfori {i}", f"+233 20 555 {i:04d}"])
ws.append([None, None]); ws.append(["No Phone", None]); ws.append(["Bad", "12"]); ws.append(["Dup", "233240000001"])
wb.create_sheet("Other").append(["phone"]); wb["Other"].append(["+233999999999"]); wb.save("t1.xlsx")
wb = Workbook(); ws = wb.active
for i in range(5): ws.append([f"+23326111{i:04d}", f"Kwame {i}"])
wb.save("t2.xlsx")
wb = Workbook(); ws = wb.active; ws.append(["Contact Name", "Phone Number", "Church"]); ws.append(["Esi Owusu", "0244123456", "Grace Chapel"]); wb.save("t3.xlsx")
open("t4.xls", "wb").write(bytes([0xD0, 0xCF, 0x11, 0xE0]) + b"\0" * 600)
open("t5.xlsx", "w").write("not really excel")
wb = Workbook(); ws = wb.active; ws.append(["name", "phone"]); ws.append(["Yaw Boateng", 244123456]); ws.append(["Abena", 201234567]); wb.save("t6.xlsx")
print("Excel fixtures written.")
