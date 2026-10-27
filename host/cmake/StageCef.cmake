# Stage the CEF runtime next to a stable directory so build dirs stay cheap.
#   cmake -DCEF_SRC=/path/to/cef -DDEST=/path/to/host/cef-runtime -P StageCef.cmake
#
# Files are hardlinked when the filesystem allows it (the 1.4 GB libcef.so is
# then free) and copied otherwise. Existing files are left alone, so a rebuild
# costs a stat per file; delete DEST to refresh after a CEF upgrade.
if(NOT DEFINED CEF_SRC OR NOT DEFINED DEST)
  message(FATAL_ERROR "StageCef.cmake needs -DCEF_SRC and -DDEST")
endif()

set(_release "${CEF_SRC}/Release")
set(_resources "${CEF_SRC}/Resources")

file(MAKE_DIRECTORY "${DEST}")

function(rook_link src)
  get_filename_component(_name "${src}" NAME)
  set(_dst "${DEST}/${_name}")
  if(EXISTS "${_dst}")
    return()
  endif()
  if(NOT EXISTS "${src}")
    message(WARNING "missing CEF file: ${src}")
    return()
  endif()
  # COPY_ON_ERROR falls back to a copy across filesystem boundaries.
  file(CREATE_LINK "${src}" "${_dst}" COPY_ON_ERROR)
  message(STATUS "staged ${_name}")
endfunction()

foreach(_f libcef.so chrome-sandbox v8_context_snapshot.bin
          libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json)
  rook_link("${_release}/${_f}")
endforeach()

foreach(_f resources.pak chrome_100_percent.pak chrome_200_percent.pak icudtl.dat)
  rook_link("${_resources}/${_f}")
endforeach()

# locales/: one pak per locale (50 MB). CEF wants the whole directory.
file(MAKE_DIRECTORY "${DEST}/locales")
file(GLOB _locales "${_resources}/locales/*.pak")
foreach(_f ${_locales})
  get_filename_component(_name "${_f}" NAME)
  set(_dst "${DEST}/locales/${_name}")
  if(NOT EXISTS "${_dst}")
    file(CREATE_LINK "${_f}" "${_dst}" COPY_ON_ERROR)
  endif()
endforeach()
