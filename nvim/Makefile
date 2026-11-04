.PHONY: test test-file

# Run the whole suite headless via plenary's busted runner.
test:
	nvim --headless --noplugin -i NONE -u tests/minimal_init.lua \
		-c "PlenaryBustedDirectory tests/ { minimal_init = 'tests/minimal_init.lua' }"

# Run a single spec file: make test-file FILE=tests/scan_spec.lua
#
# Calls busted directly rather than going through :PlenaryBustedFile, which
# cannot forward `-u` and so loads the user's real init.lua. Running
# in-process under our own -u keeps the run hermetic.
test-file:
	nvim --headless --noplugin -i NONE -u tests/minimal_init.lua \
		-c "lua require('plenary.busted').run(vim.fn.fnamemodify('$(FILE)', ':p'))"
