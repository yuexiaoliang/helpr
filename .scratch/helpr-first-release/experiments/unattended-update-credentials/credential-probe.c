// Throwaway diagnosis: only the uniquely named virtual item below is accessible.
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#ifndef PROBE_VARIANT
#error PROBE_VARIANT must be fixed by the bounded diagnostic runner
#endif

static const char service[] = "helpr Unattended Update Probe 20261013";
static const char account[] = "helpr Unattended Update Probe Virtual Key";
static const char sample[] = "HELPR-VIRTUAL-DIAGNOSTIC-ONLY-20261013";

int main(int argc, const char **argv) {
  if (argc != 2) return 2;
  const char *operation = argv[1];
  if (strcmp(operation, "create-read") && strcmp(operation, "read") &&
      strcmp(operation, "delete") && strcmp(operation, "absent")) return 2;
  OSStatus interaction = SecKeychainSetUserInteractionAllowed(false);
  if (interaction != errSecSuccess) return 3;
  SecKeychainItemRef item = NULL;
  OSStatus found = SecKeychainFindGenericPassword(NULL, strlen(service), service,
    strlen(account), account, NULL, NULL, &item);
  if (!strcmp(operation, "absent")) {
    printf("{\"variant\":%d,\"operation\":\"absent\",\"status\":%d,\"absent\":%s}\n",
      PROBE_VARIANT, (int)found, found == errSecItemNotFound ? "true" : "false");
    if (item) CFRelease(item);
    return found == errSecItemNotFound ? 0 : 4;
  }
  if (!strcmp(operation, "create-read")) {
    if (item) { CFRelease(item); return 5; } // Never overwrite or adopt old data.
    if (found != errSecItemNotFound) return 6;
    found = SecKeychainAddGenericPassword(NULL, strlen(service), service,
      strlen(account), account, strlen(sample), sample, &item);
    if (found != errSecSuccess) {
      printf("{\"variant\":%d,\"operation\":\"create\",\"status\":%d}\n", PROBE_VARIANT, (int)found);
      return 7;
    }
  }
  if (!strcmp(operation, "delete")) {
    OSStatus deleted = found == errSecSuccess ? SecKeychainItemDelete(item) : found;
    printf("{\"variant\":%d,\"operation\":\"delete\",\"status\":%d}\n", PROBE_VARIANT, (int)deleted);
    if (item) CFRelease(item);
    return deleted == errSecSuccess ? 0 : 8;
  }
  if (item) CFRelease(item);
  UInt32 length = 0;
  void *bytes = NULL;
  OSStatus read = SecKeychainFindGenericPassword(NULL, strlen(service), service,
    strlen(account), account, &length, &bytes, NULL);
  bool matches = read == errSecSuccess && length == strlen(sample) &&
    memcmp(bytes, sample, length) == 0;
  if (bytes) SecKeychainItemFreeContent(NULL, bytes);
  printf("{\"variant\":%d,\"operation\":\"%s\",\"status\":%d,\"matches\":%s,\"interactionAllowed\":false}\n",
    PROBE_VARIANT, operation, (int)read, matches ? "true" : "false");
  return matches ? 0 : 9;
}
