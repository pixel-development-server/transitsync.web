import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { Select } from './form.jsx';

/** True when the signed-in principal is a platform Super Administrator. */
export function usePlatformScope() {
  const { user } = useAuth();
  const isPlatform = Number(user?.roleLevel ?? 0) >= 200;
  return { isPlatform };
}

/** Fetch the campus directory when a platform principal is viewing a scoped registry. */
export function useCampusDirectory(enabled = true) {
  const { isPlatform } = usePlatformScope();
  const { data, error, loading } = useApi('/super-admin/colleges', { enabled: enabled && isPlatform });
  return {
    isPlatform,
    colleges: data?.colleges ?? [],
    loading,
    error,
  };
}

/** A compact campus picker shown only to platform principals. */
export function CampusSelect({ isPlatform, colleges = [], value, onChange, wrapperClass = 'w-56' }) {
  if (!isPlatform) return null;
  return (
    <Select
      wrapperClass={wrapperClass}
      label="Campus"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
      options={colleges.map((college) => ({ value: college.id, label: college.name }))}
      placeholder="Pick a campus…"
    />
  );
}

export default { usePlatformScope, useCampusDirectory, CampusSelect };
