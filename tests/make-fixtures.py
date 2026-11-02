"""Create the test fixtures used by the dashboard tests."""
import wave
w = wave.open("msg.wav", "w"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
w.writeframes(b"\x00\x00" * 8000 * 42); w.close()
rows = ["phone,name"] + [f"+23324{1000000+i:07d},Member {i}" for i in range(300)] + ["+233241000001,Dup", "abc,Bad", "12,Short"]
open("list.csv", "w").write("\n".join(rows))
rows = ["phone,first_name,last_name,company"] + [f"+23320{2000000+i:07d},Name{i},Last{i},Grace Chapel" for i in range(120)] \
     + [f"+23320{3000000+i:07d},,," for i in range(10)] + ["+233202000001,Dup,,", "bad,,,"]
open("group.csv", "w").write("\n".join(rows))
print("Fixtures written.")
