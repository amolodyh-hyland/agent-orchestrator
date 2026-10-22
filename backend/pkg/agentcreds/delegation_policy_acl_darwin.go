//go:build darwin && cgo

package agentcreds

/*
#include <errno.h>
#include <fcntl.h>
#include <membership.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <sys/acl.h>

static void ao_policy_path_free(char *path) { free(path); }

static int ao_policy_acl_trusted(const char *path) {
	acl_t acl = acl_get_link_np(path, ACL_TYPE_EXTENDED);
	if (acl == NULL) {
		// ENOENT also means the security descriptor has no ACL property. Require
		// a successful native security lookup proving that absence, not a stat.
		if (errno != ENOENT) return 0;
		filesec_t security = filesec_init();
		if (security == NULL) return 0;
		struct stat info;
		int present = 1;
		int absent = lstatx_np(path, &info, security) == 0 &&
			!S_ISLNK(info.st_mode) &&
			filesec_query_property(security, FILESEC_ACL, &present) == 0 && !present;
		filesec_free(security);
		return absent;
	}
	int trusted = 0;
	if (acl_valid(acl) != 0) goto done;
	const acl_permset_mask_t mutations = ACL_WRITE_DATA | ACL_APPEND_DATA |
		ACL_DELETE | ACL_DELETE_CHILD | ACL_WRITE_ATTRIBUTES |
		ACL_WRITE_EXTATTRIBUTES | ACL_WRITE_SECURITY | ACL_CHANGE_OWNER;
	const acl_permset_mask_t known = mutations | ACL_READ_DATA | ACL_EXECUTE |
		ACL_READ_ATTRIBUTES | ACL_READ_EXTATTRIBUTES | ACL_READ_SECURITY | ACL_SYNCHRONIZE;
	for (int index = 0; index <= ACL_MAX_ENTRIES; index++) {
		acl_entry_t entry;
		errno = 0;
		if (acl_get_entry(acl, index, &entry) != 0) {
			// Darwin reports EINVAL at the end of a validated ACL, not POSIX's 0.
			trusted = (errno == EINVAL);
			goto done;
		}
		acl_tag_t tag;
		acl_permset_mask_t permissions;
		if (acl_get_tag_type(entry, &tag) != 0 ||
			acl_get_permset_mask_np(entry, &permissions) != 0) goto done;
		if (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY) goto done;
		if ((permissions & ~known) != 0) goto done;
		// Denies never compensate for an unsafe allow, including inherited grants.
		if (tag == ACL_EXTENDED_DENY || (permissions & mutations) == 0) continue;
		void *qualifier = acl_get_qualifier(entry);
		if (qualifier == NULL) goto done;
		id_t identity;
		int type;
		int resolved = mbr_uuid_to_id(qualifier, &identity, &type);
		acl_free(qualifier);
		// Only root and wheel (gid 0) may mutate a protected source. In particular,
		// admin and staff are not system authority, even on a root-owned file.
		if (resolved != 0 || identity != 0 ||
			(type != ID_TYPE_UID && type != ID_TYPE_GID)) goto done;
	}
done:
	acl_free(acl);
	return trusted;
}
*/
import "C"

import (
	"os"
	"strings"
)

func protectedEmptyPolicyOwner(path string, info os.FileInfo) bool {
	return protectedPolicyOwner(path, info)
}

func protectedPolicyACL(path string) bool {
	if strings.IndexByte(path, 0) >= 0 {
		return false
	}
	nativePath := C.CString(path)
	defer C.ao_policy_path_free(nativePath)
	return C.ao_policy_acl_trusted(nativePath) == 1
}
