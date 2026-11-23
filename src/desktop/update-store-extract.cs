using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

// Extract into an empty staging directory. No archive-supplied permissions,
// streams, links, or filesystem timestamps are installed.
class PortableUpdateExtractor
{
    const long MaxBytes = 2L * 1024 * 1024 * 1024;
    static readonly Regex SafeName = new Regex(@"\A[a-zA-Z0-9_ .@+\-]+\z");
    static readonly Regex DeviceName = new Regex(@"^(CON|AUX|PRN|NUL|COM[0-9]|LPT[0-9]) *(\.|$)", RegexOptions.IgnoreCase);

    static void Require(bool condition)
    {
        if (!condition) throw new InvalidDataException("Invalid portable update package.");
    }

    static void Extract(string zipPath, string destination, string version, string digest)
    {
        Require(Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length == 0);
        using (var input = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            // Verify the file we actually extract from the same read-only handle.
            using (var sha = SHA256.Create())
                Require(String.Equals(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", ""), digest, StringComparison.OrdinalIgnoreCase));
            input.Position = 0;
            using (var archive = new ZipArchive(input, ZipArchiveMode.Read))
            {
                Require(archive.Entries.Count > 0 && archive.Entries.Count <= 4096);
                var entries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                string wrapper = null;
                long total = 0;
                var buffer = new byte[128 * 1024];
                foreach (var entry in archive.Entries)
                {
                    bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal);
                    string name = directory ? entry.FullName.Substring(0, entry.FullName.Length - 1) : entry.FullName;
                    string[] parts = name.Split('/');
                    Require(parts.Length <= 32 && name.Length <= 1024 && entries.Add(name));
                    if (wrapper == null)
                    {
                        wrapper = parts[0];
                        Require(wrapper == "HOTAS Uplink" || wrapper == "HOTAS-Uplink-" + version);
                    }
                    int type = (entry.ExternalAttributes >> 16) & 0xF000;
                    Require((entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) == 0);
                    Require(type == 0 || type == (directory ? 0x4000 : 0x8000));
                    Require(parts[0] == wrapper && (parts.Length > 1 || directory));
                    string target = destination;
                    for (int i = 1; i < parts.Length; i++)
                    {
                        string part = parts[i];
                        Require(part.Length > 0 && part.Length <= 255 && SafeName.IsMatch(part) &&
                                !part.EndsWith(".") && !part.EndsWith(" ") && !DeviceName.IsMatch(part));
                        target = Path.Combine(target, part);
                    }
                    if (directory)
                    {
                        Require(entry.Length == 0);
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Require(entry.Length >= 0 && entry.Length <= MaxBytes - total);
                    total += entry.Length;
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var source = entry.Open())
                    using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        long remaining = entry.Length;
                        int count;
                        while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            Require(count <= remaining);
                            output.Write(buffer, 0, count);
                            remaining -= count;
                        }
                        Require(remaining == 0);
                    }
                }
            }
        }
    }

    static int Main(string[] args)
    {
        try
        {
            Require(args.Length == 4);
            Extract(args[0], args[1], args[2], args[3]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
