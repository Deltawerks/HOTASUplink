using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// DirectInput8W for supported flight controller vendors.
// DISCL_BACKGROUND | DISCL_NONEXCLUSIVE lets a game use the sticks concurrently.
internal static class DirectInput
{
    [DllImport("dinput8.dll")]
    internal static extern int DirectInput8Create(IntPtr module, int version, ref Guid iid, out IntPtr input, IntPtr outer);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr GetModuleHandle(string name);

    // These method slots follow IDirectInput8W and IDirectInputDevice8W in dinput.h.
    internal const int CreateDevice = 3, EnumDevices = 4;
    internal const int GetCapabilities = 3, EnumObjects = 4, GetProperty = 5, SetProperty = 6, Acquire = 7, Unacquire = 8;
    internal const int GetDeviceState = 9, GetDeviceData = 10, SetDataFormat = 11, SetEventNotification = 12, SetCooperativeLevel = 13, Poll = 25;
    internal delegate int EnumerateCallback(IntPtr description, IntPtr context);
    internal delegate int ListDevices(IntPtr self, int kind, EnumerateCallback callback, IntPtr context, int flags);
    internal delegate int OpenDevice(IntPtr self, ref Guid id, out IntPtr device, IntPtr outer);
    internal delegate int ListObjects(IntPtr self, EnumerateCallback callback, IntPtr context, int kinds);
    internal delegate int SetFormat(IntPtr self, ref DataFormat format);
    internal delegate int SetCooperation(IntPtr self, IntPtr window, int flags);
    internal delegate int Notify(IntPtr self, IntPtr signal);
    internal delegate int Simple(IntPtr self);
    internal delegate int ReadState(IntPtr self, int size, IntPtr data);
    internal delegate int ReadEvents(IntPtr self, int eventSize, IntPtr data, ref int count, int flags);
    internal delegate int SetDword(IntPtr self, IntPtr key, ref DwordProperty property);
    internal delegate int ReadRange(IntPtr self, IntPtr key, ref RangeProperty property);
    internal delegate int ReadCaps(IntPtr self, ref DeviceCaps caps);

    internal static T Method<T>(IntPtr self, int slot) where T : class
    {
        IntPtr address = Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
    }
    internal static void Check(int result, string operation)
    {
        if (result < 0) throw new InvalidOperationException(operation + " (0x" + result.ToString("X8") + ")");
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct DeviceInfo
    {
        public int Size;
        public Guid Instance, Product;
        public int Type;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string InstanceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ProductName;
        public Guid FFDriver;
        public ushort UsagePage, Usage;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct ObjectInfo
    {
        public int Size;
        public Guid TypeGuid;
        public int Offset, Type, Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        public int MaxForce, ForceResolution;
        public ushort Collection, Designator, UsagePage, Usage;
        public int Dimension;
        public ushort Exponent, Report;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ObjectFormat { public IntPtr Guid; public int Offset, Type, Flags; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct DataFormat { public int Size, ObjectSize, Flags, DataSize, Count; public IntPtr Objects; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct RangeProperty { public int Size, HeaderSize, Object, How, Min, Max; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct DwordProperty { public int Size, HeaderSize, Object, How, Value; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct DeviceCaps
    {
        public int Size, Flags, DeviceType, Axes, Buttons, Povs, FFSamplePeriod, FFMinTimeResolution, Firmware, Hardware, FFDriver;
    }
}

internal sealed class Stick : IDisposable
{
    private sealed class Control
    {
        internal int Type, Number, Offset, Raw, Min, Max;
        internal string Kind, Axis;
    }

    private IntPtr device, buffer, events;
    private readonly List<Control> controls = new List<Control>();
    private DirectInput.Simple poll, acquire;
    private DirectInput.ReadState read;
    private DirectInput.ReadEvents readEvents;
    private DirectInput.Notify notify;
    private ManualResetEvent signal;
    private bool eventDriven;
    private long nextRead, nextSignalRead;
    private int retryMs = 250;
    private const int QueueSize = 256;
    private static readonly int EventSize = 16 + IntPtr.Size;
    private bool hasBaseline;
    internal bool Readable { get { return hasBaseline; } }
    internal readonly DirectInput.DeviceInfo Info;
    private string Id { get { return Info.Instance.ToString("D"); } }
    private static readonly string[] Directions = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
    private static readonly string[] Axes = { "X", "Y", "Z", "RX", "RY", "RZ", "SLIDER1", "SLIDER2" };

    internal Stick(IntPtr input, IntPtr window, DirectInput.DeviceInfo info)
    {
        Info = info;
        Guid guid = info.Instance;
        try
        {
            DirectInput.Check(DirectInput.Method<DirectInput.OpenDevice>(input, DirectInput.CreateDevice)(
                input, ref guid, out device, IntPtr.Zero), "Open " + info.ProductName);
            DirectInput.Check(DirectInput.Method<DirectInput.SetCooperation>(device, DirectInput.SetCooperativeLevel)(
                device, window, 0x0a), "Set background input");
            DirectInput.Check(DirectInput.Method<DirectInput.ListObjects>(device, DirectInput.EnumObjects)(
                device, AddObject, IntPtr.Zero, 0x1f), "Enumerate joystick controls");
            if (controls.Count == 0) throw new InvalidOperationException("No readable input controls.");
            SetDataLayout();
            buffer = Marshal.AllocHGlobal(controls.Count * 4);
            acquire = DirectInput.Method<DirectInput.Simple>(device, DirectInput.Acquire);
            poll = DirectInput.Method<DirectInput.Simple>(device, DirectInput.Poll);
            read = DirectInput.Method<DirectInput.ReadState>(device, DirectInput.GetDeviceState);
            // This buffer belongs to our DirectInput client. It preserves quick
            // taps and encoder pulses between polls and does not reprogram the stick.
            var queue = new DirectInput.DwordProperty { Size = 20, HeaderSize = 16, Value = QueueSize };
            if (DirectInput.Method<DirectInput.SetDword>(device, DirectInput.SetProperty)(
                    device, new IntPtr(1), ref queue) >= 0)
            {
                events = Marshal.AllocHGlobal(QueueSize * EventSize);
                readEvents = DirectInput.Method<DirectInput.ReadEvents>(device, DirectInput.GetDeviceData);
            }
            // GetCapabilities reports whether the *selected data format* requires Poll.
            var caps = new DirectInput.DeviceCaps { Size = Marshal.SizeOf(typeof(DirectInput.DeviceCaps)) };
            if (DirectInput.Method<DirectInput.ReadCaps>(device, DirectInput.GetCapabilities)(device, ref caps) >= 0 &&
                (caps.Flags & 0x8) == 0) // DIDC_POLLEDDATAFORMAT
            {
                notify = DirectInput.Method<DirectInput.Notify>(device, DirectInput.SetEventNotification);
                signal = new ManualResetEvent(false);
                int notification = notify(device, signal.SafeWaitHandle.DangerousGetHandle());
                eventDriven = notification == 0; // DI_OK; DI_POLLEDDEVICE still needs regular Poll.
                if (notification < 0) { signal.Dispose(); signal = null; }
            }
        }
        catch { Dispose(); throw; }
    }

    private int AddObject(IntPtr description, IntPtr context)
    {
        var obj = (DirectInput.ObjectInfo)Marshal.PtrToStructure(description, typeof(DirectInput.ObjectInfo));
        int type = obj.Type & 0xff;
        int instance = (obj.Type >> 8) & 0xffff;
        var control = new Control { Type = obj.Type, Offset = controls.Count * 4, Number = instance + 1 };
        if ((type & 0x0c) != 0) control.Kind = "button";
        else if ((type & 0x10) != 0) control.Kind = "hat";
        else if ((type & 0x03) != 0)
        {
            control.Kind = "axis";
            // HID usages 30..35 are X/Y/Z/Rx/Ry/Rz. Slider and Dial become sliders.
            int usage = obj.Usage - 0x30;
            if (obj.UsagePage == 1 && usage >= 0 && usage < 6) control.Axis = Axes[usage];
            else if (obj.UsagePage == 1 && (usage == 6 || usage == 7))
                control.Axis = "SLIDER" + (1 + controls.Count(c => c.Axis != null && c.Axis.StartsWith("SLIDER")));
            else control.Axis = "AXIS" + (instance + 1);
        }
        else return 1;
        controls.Add(control);
        return 1;
    }

    private void SetDataLayout()
    {
        int objectSize = Marshal.SizeOf(typeof(DirectInput.ObjectFormat));
        var layout = new DirectInput.DataFormat {
            Size = Marshal.SizeOf(typeof(DirectInput.DataFormat)), ObjectSize = objectSize,
            Flags = 1, Count = controls.Count, DataSize = controls.Count * 4,
            Objects = Marshal.AllocHGlobal(controls.Count * objectSize)
        };
        try
        {
            for (int i = 0; i < controls.Count; i++)
            {
                var item = new DirectInput.ObjectFormat { Type = controls[i].Type, Offset = controls[i].Offset };
                Marshal.StructureToPtr(item, IntPtr.Add(layout.Objects, i * objectSize), false);
            }
            DirectInput.Check(DirectInput.Method<DirectInput.SetFormat>(device, DirectInput.SetDataFormat)(
                device, ref layout), "Set joystick input layout");
        }
        finally { Marshal.FreeHGlobal(layout.Objects); }

        var getRange = DirectInput.Method<DirectInput.ReadRange>(device, DirectInput.GetProperty);
        foreach (var axis in controls.Where(c => c.Kind == "axis"))
        {
            var range = new DirectInput.RangeProperty {
                Size = 24, HeaderSize = 16, Object = axis.Type, How = 2
            };
            if (getRange(device, new IntPtr(4), ref range) >= 0 && range.Max > range.Min)
            {
                axis.Min = range.Min;
                axis.Max = range.Max;
            }
        }
    }

    internal object Describe()
    {
        byte[] product = Info.Product.ToByteArray();
        return new {
            id = Id, name = Info.ProductName.Trim(), instanceName = Info.InstanceName.Trim(),
            vid = BitConverter.ToUInt16(product, 0).ToString("X4"),
            pid = BitConverter.ToUInt16(product, 2).ToString("X4"),
            buttonCount = controls.Count(c => c.Kind == "button"),
            hatCount = controls.Count(c => c.Kind == "hat"), axisCount = controls.Count(c => c.Kind == "axis"),
            axes = controls.Where(c => c.Kind == "axis").Select(c => c.Axis).ToArray(),
            readable = hasBaseline, buffered = readEvents != null,
            pressedButtons = controls.Where(c => hasBaseline && c.Kind == "button" && c.Raw != 0)
                                    .Select(c => c.Number).OrderBy(n => n).ToArray()
        };
    }

    // Manual-reset lets the wait loop observe a signaled stick without
    // consuming its event. Reset before reading so subsequent input wakes us.
    internal WaitHandle WakeHandle(long now)
    {
        return eventDriven && hasBaseline && now >= nextSignalRead ? signal : null;
    }

    internal long NextDeadline(long now)
    {
        return eventDriven && hasBaseline && now < nextSignalRead ? Math.Min(nextSignalRead, nextRead) : nextRead;
    }

    // Return true on loss or resumption so held buttons are reconciled in the snapshot.
    internal bool Read(long now)
    {
        var wake = WakeHandle(now);
        if (now < nextRead && (wake == null || !wake.WaitOne(0))) return false;
        if (eventDriven) signal.Reset();
        bool wasReadable = hasBaseline;
        if (ReadDevice())
        {
            hasBaseline = true;
            retryMs = 250;
            nextSignalRead = now + 8;
            nextRead = now + (eventDriven ? 30000 : 8);
        }
        else
        {
            hasBaseline = false;
            nextRead = now + retryMs;
            retryMs = Math.Min(2000, retryMs * 2);
        }
        return wasReadable != hasBaseline;
    }

    private bool ReadDevice()
    {
        if (!hasBaseline && acquire(device) < 0) return false;
        if (!eventDriven && poll(device) < 0) return false;
        int result;
        if (readEvents != null)
        {
            int count = QueueSize;
            result = readEvents(device, EventSize, events, ref count, 0);
            if (result >= 0 && hasBaseline)
            {
                for (int i = 0; i < count; i++)
                {
                    int offset = Marshal.ReadInt32(events, i * EventSize);
                    int index = offset / 4;
                    if (offset < 0 || offset % 4 != 0 || index >= controls.Count) continue;
                    Record(controls[index], Marshal.ReadInt32(events, i * EventSize + 4));
                }
                // DI_BUFFEROVERFLOW means the oldest events were lost. Reconcile
                // the held state below so a dropped release cannot stick in the UI.
                if (result == 0) return true;
            }
        }
        result = read(device, controls.Count * 4, buffer);
        if (result < 0) return false;
        foreach (var control in controls)
        {
            int raw = control.Kind == "button" ? Marshal.ReadByte(buffer, control.Offset)
                                               : Marshal.ReadInt32(buffer, control.Offset);
            Record(control, raw);
        }
        return true;
    }

    private void Record(Control control, int raw)
    {
        if (control.Kind == "button") raw &= 0x80;
        if (hasBaseline && control.Raw != raw)
        {
            if (control.Kind == "button")
                Reader.Emit(new { type = "button", id = Id, button = control.Number, pressed = raw != 0 });
            else if (control.Kind == "hat")
            {
                int angle = raw & 0xffff;
                string direction = angle < 36000 ? Directions[((angle + 2250) / 4500) % 8] : null;
                Reader.Emit(new { type = "hat", id = Id, hat = control.Number, direction = direction });
            }
            else if (control.Max > control.Min)
            {
                double span = (double)control.Max - control.Min;
                // Accumulate small changes until the position has moved by 1% of full travel.
                if (Math.Abs((double)raw - control.Raw) / span < 0.01) return;
                double normalized = Math.Max(-1, Math.Min(1, 2 * (raw - (double)control.Min) / span - 1));
                double previous = Math.Max(-1, Math.Min(1, 2 * (control.Raw - (double)control.Min) / span - 1));
                Reader.Emit(new { type = "axis", id = Id, axis = control.Axis, value = Math.Round(normalized, 4),
                    delta = Math.Round(normalized - previous, 4) });
            }
        }
        control.Raw = raw;
    }

    public void Dispose()
    {
        if (device != IntPtr.Zero)
        {
            DirectInput.Method<DirectInput.Simple>(device, DirectInput.Unacquire)(device);
            if (signal != null && notify != null) notify(device, IntPtr.Zero);
            Marshal.Release(device);
            device = IntPtr.Zero;
        }
        if (buffer != IntPtr.Zero) { Marshal.FreeHGlobal(buffer); buffer = IntPtr.Zero; }
        if (events != IntPtr.Zero) { Marshal.FreeHGlobal(events); events = IntPtr.Zero; }
        if (signal != null) { signal.Dispose(); signal = null; }
    }
}

internal sealed class DeviceWindow : Form
{
    internal bool TopologyChanged;
    protected override void WndProc(ref Message message)
    {
        // Windows broadcasts DBT_DEVNODES_CHANGED to top-level windows.
        if (message.Msg == 0x0219 && message.WParam.ToInt64() == 0x0007) TopologyChanged = true;
        base.WndProc(ref message);
    }
}

internal static class Reader
{
    private static volatile bool stop;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); }
    private static void Listening() { Emit(new { type = "status", level = "info", message = "Listening for flight controls in the background." }); }

    private static List<DirectInput.DeviceInfo> ListConnected(IntPtr input)
    {
        var connected = new List<DirectInput.DeviceInfo>();
        DirectInput.Check(DirectInput.Method<DirectInput.ListDevices>(input, DirectInput.EnumDevices)(
            input, 4, delegate(IntPtr desc, IntPtr context) {
                var info = (DirectInput.DeviceInfo)Marshal.PtrToStructure(desc, typeof(DirectInput.DeviceInfo));
                ushort vendor = BitConverter.ToUInt16(info.Product.ToByteArray(), 0);
                if (vendor == 0x231d || vendor == 0x3344) connected.Add(info);
                return 1;
            }, IntPtr.Zero, 1), "Enumerate connected game controllers");
        return connected;
    }

    private static bool OpenSticks(IntPtr input, IntPtr hwnd, List<DirectInput.DeviceInfo> devices,
        Dictionary<Guid, Stick> sticks, Dictionary<Guid, string> unavailable)
    {
        bool changed = false;
        foreach (var device in devices)
        {
            if (sticks.ContainsKey(device.Instance)) continue;
            try
            {
                sticks.Add(device.Instance, new Stick(input, hwnd, device));
                unavailable.Remove(device.Instance);
                changed = true;
            }
            catch (Exception ex)
            {
                string last;
                if (!unavailable.TryGetValue(device.Instance, out last) || last != ex.Message)
                    Emit(new { type = "status", level = "warning", message = device.ProductName + ": " + ex.Message });
                unavailable[device.Instance] = ex.Message;
            }
        }
        return changed;
    }

    [STAThread]
    internal static int Main()
    {
        var sticks = new Dictionary<Guid, Stick>();
        var unavailable = new Dictionary<Guid, string>();
        IntPtr input = IntPtr.Zero;
        // The pipe closes if the parent application crashes or exits.
        var watchParent = new Thread(delegate() {
            try { Console.In.ReadLine(); }
            catch (System.IO.IOException) { /* A broken parent pipe also ends this reader. */ }
            finally { stop = true; }
        });
        watchParent.IsBackground = true;
        watchParent.Start();
        using (var window = new DeviceWindow())
        try
        {
            IntPtr hwnd = window.Handle; // Receive change notifications even if no stick is attached at launch.
            Guid iid = new Guid("bf798031-483a-4da2-aa99-5d64ed369700");
            DirectInput.Check(DirectInput.DirectInput8Create(DirectInput.GetModuleHandle(null), 0x800, ref iid,
                out input, IntPtr.Zero), "Start DirectInput");
            Listening();
            var timer = Stopwatch.StartNew();
            long nextScan = 0, retryOpen = long.MaxValue;
            var devices = new List<DirectInput.DeviceInfo>();
            string scanError = null;
            bool refresh = true, warned = false;
            while (!stop)
            {
                Application.DoEvents();
                long now = timer.ElapsedMilliseconds;
                if (window.TopologyChanged)
                {
                    window.TopologyChanged = false;
                    nextScan = Math.Min(nextScan, now + 350);
                }
                if (now >= nextScan)
                {
                    // A slow fallback catches missed broadcasts and resumes after sleep.
                    nextScan = now + 60000;
                    try
                    {
                        devices = ListConnected(input);
                        scanError = null;
                        var present = devices.ToDictionary(d => d.Instance);
                        foreach (var pair in sticks.ToArray())
                        {
                            DirectInput.DeviceInfo descriptor;
                            if (present.TryGetValue(pair.Key, out descriptor) && pair.Value.Readable &&
                                pair.Value.Info.Product == descriptor.Product && pair.Value.Info.ProductName == descriptor.ProductName) continue;
                            pair.Value.Dispose();
                            sticks.Remove(pair.Key);
                            refresh = true;
                        }
                        foreach (var id in unavailable.Keys.Where(id => !present.ContainsKey(id)).ToArray()) unavailable.Remove(id);
                        retryOpen = now;
                    }
                    catch (InvalidOperationException ex)
                    {
                        if (scanError != ex.Message) Emit(new { type = "status", level = "warning", message = ex.Message });
                        scanError = ex.Message;
                        nextScan = now + 5000;
                    }
                }
                if (now >= retryOpen)
                {
                    if (OpenSticks(input, hwnd, devices, sticks, unavailable)) refresh = true;
                    retryOpen = unavailable.Count == 0 ? long.MaxValue : now + 5000;
                }
                foreach (var stick in sticks.Values)
                {
                    if (!stick.Read(now)) continue;
                    refresh = true;
                    if (!stick.Readable) nextScan = Math.Min(nextScan, now + 1500);
                }
                if (scanError != null || unavailable.Count != 0) warned = true;
                else if (warned && sticks.Values.All(s => s.Readable))
                {
                    Listening();
                    warned = false;
                }
                if (refresh)
                {
                    Emit(new { type = "devices", devices = sticks.Values.Select(s => s.Describe()).ToArray() });
                    refresh = false;
                }
                WaitForInput(sticks.Values, Math.Min(nextScan, retryOpen), timer.ElapsedMilliseconds);
            }
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
        finally
        {
            foreach (var stick in sticks.Values) stick.Dispose();
            if (input != IntPtr.Zero) Marshal.Release(input);
        }
    }

    private static void WaitForInput(IEnumerable<Stick> sticks, long nextScan, long now)
    {
        // Wake promptly on reported input. The short upper bound keeps the hidden
        // window's plug/unplug messages and parent-pipe closure responsive when idle.
        long due = Math.Min(nextScan, now + 250);
        var handles = new List<WaitHandle>();
        foreach (var stick in sticks)
        {
            due = Math.Min(due, stick.NextDeadline(now));
            var signal = stick.WakeHandle(now);
            if (signal != null) handles.Add(signal);
        }
        int delay = (int)Math.Max(0, due - now);
        if (delay == 0) return;
        if (handles.Count == 0) Thread.Sleep(delay);
        else if (handles.Count <= 63) WaitHandle.WaitAny(handles.ToArray(), delay);
        else Thread.Sleep(Math.Min(8, delay)); // STA waits support up to 63 handles.
    }
}
