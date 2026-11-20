using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

// An in-process DirectInput vtable supplies deterministic inputs. The real reader
// Main, Windows controller enumeration, and desktop window are never entered.
internal sealed class FakeJoystick : IDisposable
{
    private readonly List<Delegate> callbacks = new List<Delegate>();
    private readonly IntPtr table = Marshal.AllocHGlobal(26 * IntPtr.Size);
    private readonly IntPtr instance = Marshal.AllocHGlobal(IntPtr.Size);
    private readonly IntPtr rootTable = Marshal.AllocHGlobal(4 * IntPtr.Size);
    private readonly IntPtr root = Marshal.AllocHGlobal(IntPtr.Size);
    internal readonly Stick Stick;
    internal int Acquires, Polls, States, Drains;
    internal bool Held, ReleaseQueued, Overflow, Lost, CanAcquire = true, Detached, Released;
    private readonly int[] axes = { 32768, 32768, 32768 };
    private int pendingAxis = -1;
    private IntPtr signal;

    private void Slot(int index, Delegate fn)
    {
        callbacks.Add(fn);
        Marshal.WriteIntPtr(table, index * IntPtr.Size, Marshal.GetFunctionPointerForDelegate(fn));
    }

    internal FakeJoystick(int notificationResult, bool requiresPolling = false)
    {
        Marshal.WriteIntPtr(instance, table);
        Marshal.WriteIntPtr(root, rootTable);
        Slot(2, new DirectInput.Simple(self => { Released = true; return 0; }));
        var open = new DirectInput.OpenDevice(delegate(IntPtr self, ref Guid guid, out IntPtr dev, IntPtr outer) {
            dev = instance; return 0;
        });
        callbacks.Add(open);
        Marshal.WriteIntPtr(rootTable, DirectInput.CreateDevice * IntPtr.Size, Marshal.GetFunctionPointerForDelegate(open));
        Slot(DirectInput.GetCapabilities, new DirectInput.ReadCaps(delegate(IntPtr self, ref DirectInput.DeviceCaps caps) {
            caps.Flags = requiresPolling ? 8 : 0; return 0;
        }));
        Slot(DirectInput.EnumObjects, new DirectInput.ListObjects(delegate(IntPtr self, DirectInput.EnumerateCallback add, IntPtr context, int flags) {
            var descriptors = new[] {
                new DirectInput.ObjectInfo { Type = (69 << 8) | 4, Name = "B70" },
                new DirectInput.ObjectInfo { Type = 0x202, Name = "Z Axis", UsagePage = 1, Usage = 0x32 },
                new DirectInput.ObjectInfo { Type = 0x602, Name = "Slider", UsagePage = 1, Usage = 0x36 },
                new DirectInput.ObjectInfo { Type = 0x702, Name = "Dial", UsagePage = 1, Usage = 0x37 },
            };
            IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(DirectInput.ObjectInfo)));
            try { foreach (var descriptor in descriptors) { Marshal.StructureToPtr(descriptor, data, false); add(data, context); } }
            finally { Marshal.FreeHGlobal(data); }
            return 0;
        }));
        Slot(DirectInput.GetProperty, new DirectInput.ReadRange(delegate(IntPtr self, IntPtr key, ref DirectInput.RangeProperty range) {
            range.Min = 0; range.Max = 65535; return 0;
        }));
        Slot(DirectInput.SetProperty, new DirectInput.SetDword(delegate(IntPtr self, IntPtr key, ref DirectInput.DwordProperty prop) { return 0; }));
        Slot(DirectInput.SetDataFormat, new DirectInput.SetFormat(delegate(IntPtr self, ref DirectInput.DataFormat format) { return 0; }));
        Slot(DirectInput.SetCooperativeLevel, new DirectInput.SetCooperation((self, hwnd, flags) => flags == 0x0a ? 0 : -1));
        Slot(DirectInput.Acquire, new DirectInput.Simple(self => { Acquires++; return CanAcquire ? 0 : -1; }));
        Slot(DirectInput.Unacquire, new DirectInput.Simple(self => 0));
        Slot(DirectInput.Poll, new DirectInput.Simple(self => { Polls++; return Lost ? -1 : 0; }));
        Slot(DirectInput.GetDeviceState, new DirectInput.ReadState((self, size, data) => {
            States++;
            if (Lost) return -1;
            Marshal.WriteInt32(data, Held ? 0x80 : 0);
            for (int i = 0; i < axes.Length; i++) Marshal.WriteInt32(data, (i + 1) * 4, axes[i]);
            return 0;
        }));
        Slot(DirectInput.GetDeviceData, new DirectInput.ReadEvents(delegate(IntPtr self, int stride, IntPtr data, ref int count, int flags) {
            Drains++;
            if (Lost) return -1;
            count = ReleaseQueued ? 1 : 0;
            if (ReleaseQueued) { Marshal.WriteInt32(data, 0, 0); Marshal.WriteInt32(data, 4, 0); ReleaseQueued = false; }
            if (pendingAxis >= 0)
            {
                int at = count++ * stride;
                Marshal.WriteInt32(data, at, (pendingAxis + 1) * 4);
                Marshal.WriteInt32(data, at + 4, axes[pendingAxis]);
                pendingAxis = -1;
            }
            return Overflow ? 1 : 0;
        }));
        Slot(DirectInput.SetEventNotification, new DirectInput.Notify((self, handle) => {
            signal = handle;
            if (handle == IntPtr.Zero) Detached = true;
            return notificationResult;
        }));
        Stick = new Stick(root, IntPtr.Zero, new DirectInput.DeviceInfo {
            Instance = Guid.NewGuid(), Product = Guid.NewGuid(), InstanceName = "Fixture", ProductName = "Fixture",
        });
    }

    internal void Wake()
    {
        using (var notification = new EventWaitHandle(false, EventResetMode.ManualReset))
        {
            notification.SafeWaitHandle = new Microsoft.Win32.SafeHandles.SafeWaitHandle(signal, false);
            notification.Set();
        }
    }

    internal void MoveAxis(int index, int position, long now)
    {
        pendingAxis = index;
        axes[index] = position;
        Wake();
        Stick.Read(now);
    }

    public void Dispose()
    {
        Stick.Dispose();
        Marshal.FreeHGlobal(instance);
        Marshal.FreeHGlobal(table);
        Marshal.FreeHGlobal(root);
        Marshal.FreeHGlobal(rootTable);
        GC.KeepAlive(callbacks);
    }
}

internal static class VkbReaderTests
{
    private static void Check(bool condition, string description)
    {
        if (!condition) throw new Exception(description);
    }

    internal static int Main()
    {
        var output = Console.Out;
        var events = new StringWriter();
        Console.SetOut(events);
        var joystick = new FakeJoystick(0);
        using (joystick)
        {
            var stick = joystick.Stick;
            joystick.Held = true;
            Check(stick.Read(0), "Initial snapshot");
            Check(new JavaScriptSerializer().Serialize(stick.Describe()).Contains("\"pressedButtons\":[70]"), "Initially held B70");
            Check(events.ToString() == "", "Held baseline must not synthesize a new press");
            for (int ms = 1; ms < 2000; ms++) stick.Read(ms);
            Check(joystick.Acquires == 1 && joystick.Polls == 0 && joystick.States == 1 && joystick.Drains == 1, "No idle DirectInput calls");
            joystick.Held = false; joystick.ReleaseQueued = true; joystick.Wake();
            stick.Read(2000);
            Check(events.ToString().Contains("\"button\":70,\"pressed\":false"), "Buffered release");
            joystick.Held = true; joystick.Overflow = true; joystick.Wake();
            stick.Read(2010);
            Check(events.ToString().Contains("\"button\":70,\"pressed\":true"), "Overflow reconciles state");
            joystick.Lost = true; joystick.CanAcquire = false; joystick.Wake();
            Check(stick.Read(2020) && !stick.Readable, "Input loss");
            int initial = joystick.Acquires;
            for (int ms = 2021; ms < 4020; ms++) stick.Read(ms);
            Check(joystick.Acquires - initial == 3, "Backoff limits reacquisition");
            joystick.Lost = false; joystick.CanAcquire = true;
            Check(stick.Read(6000) && stick.Readable, "Input recovery");
        }
        Check(joystick.Detached && joystick.Released, "Notification removed and device released");
        using (var wheel = new FakeJoystick(0))
        {
            events.GetStringBuilder().Clear();
            wheel.Stick.Read(0);
            wheel.MoveAxis(0, 33000, 10);
            Check(events.ToString() == "", "Small axis noise is ignored");
            wheel.MoveAxis(0, 65535, 20); wheel.MoveAxis(0, 0, 30);
            wheel.MoveAxis(1, 65535, 40); wheel.MoveAxis(2, 0, 50);
            var messages = events.ToString().Trim().Split('\n');
            var serializer = new JavaScriptSerializer();
            string[] expected = { "Z", "Z", "SLIDER1", "SLIDER2" };
            double[] delta = { 1, -2, 1, -1 };
            Check(messages.Length == 4, "One event per deliberate axis change");
            for (int i = 0; i < messages.Length; i++)
            {
                var row = serializer.Deserialize<Dictionary<string, object>>(messages[i]);
                Check((string)row["axis"] == expected[i], "Preserve independent Windows axis identities");
                Check(Math.Abs(Convert.ToDouble(row["delta"]) - delta[i]) < 0.0001, "Signed delta from last emitted position");
            }
        }
        foreach (int notification in new[] { 2, -1 })
        using (var polled = new FakeJoystick(notification))
        {
            polled.Stick.Read(0); polled.Stick.Read(7); polled.Stick.Read(8);
            Check(polled.Polls == 2 && polled.Acquires == 1, "Polled fallback honors its interval");
        }
        using (var polled = new FakeJoystick(0, true))
        {
            polled.Stick.Read(0);
            Check(polled.Polls == 1, "Selected data format requires polling");
        }
        Console.SetOut(output);
        Console.WriteLine("Passed simulated input notifications, B70 baseline, buffering, overflow, loss, backoff, polling fallback, and release.");
        return 0;
    }
}
