# Extractor fixtures

Per PROMPT §6.2, each extractor must be backed by recorded fixtures:

```
<doc-type>/<sample-name>/
  input.pdf      # real (anonymized) sample
  expected.json  # expected output of runExtractor()
```

The CI suite compares extractor output against `expected.json` on a snapshot
basis. A nightly job runs the same fixtures against the live Anthropic API
and reports accuracy drift to the AI accuracy dashboard.

Add a fixture when:
- A new document type is added
- A real-world sample fails extraction in production
- A known edge case (faded scan, glare, photocopy artifact) is encountered
